-- Goals, preferences, water, messages, agent runs, audit log.
--
-- GOALS: ONE table. `goal_targets` (a row per goal per day per nutrient) was
-- deleted from the design - a 90-day goal tracking 5 nutrients would be 450
-- rows storing the same number repeated, all derivable from daily_targets and
-- a date range. Progress is a SUM over meals, computed never stored.

CREATE TABLE IF NOT EXISTS goals (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    goal_id        uuid NOT NULL DEFAULT gen_random_uuid(),  -- stable logical id
    user_id        uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,

    kind           goal_kind NOT NULL,
    spec           jsonb NOT NULL,      -- what the user ASKED for, verbatim
    starts_on      date NOT NULL,
    ends_on        date NOT NULL,

    -- what it RESOLVES to. Computed once at creation; re-resolution mints a
    -- new version rather than mutating, so the target never drifts silently.
    daily_targets  jsonb NOT NULL DEFAULT '{"targets":[]}'::jsonb,

    -- the full audit: bmr, tdee, requested_rate, clamped_rate, clamp_fired,
    -- floor_applied, formula, trigger_reason
    derivation     jsonb NOT NULL DEFAULT '{}'::jsonb,

    status         goal_status NOT NULL DEFAULT 'active',
    version        integer NOT NULL DEFAULT 1,
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ck_goal_dates CHECK (ends_on >= starts_on),
    CONSTRAINT uq_goal_version UNIQUE (goal_id, version)
);

-- exactly ONE active goal per user - this is what makes the homepage query
-- unambiguous: WHERE user_id = $1 AND is_active returns exactly one row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_goal_active_per_user
    ON goals (user_id) WHERE is_active;

CREATE UNIQUE INDEX IF NOT EXISTS uq_goal_logical_active
    ON goals (goal_id) WHERE is_active;

-- ---------------------------------------------------------------------------
-- user_preferences - ONE table. KookarCore splits preferences from versioned
-- markdown "memories"; that split exists there because a separate agent fleet
-- with per-type SOPs maintains the memories. We have neither, and two tables
-- would mean two writers that eventually disagree.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_preferences (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pref_id      uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,

    topic_title  text NOT NULL,        -- a cluster, not a fixed enum
    content      text NOT NULL,        -- markdown bullets, deliberately not normalised

    status       text NOT NULL DEFAULT 'Active'
                 CHECK (status IN ('Active', 'Inactive')),
    type         text NOT NULL DEFAULT 'Permanent'
                 CHECK (type IN ('Permanent', 'Temporary')),
    expires_on   date,                 -- required in spirit when type='Temporary'
    source       text NOT NULL DEFAULT 'questionnaire'
                 CHECK (source IN ('questionnaire', 'chat', 'manual', 'inferred')),

    version      integer NOT NULL DEFAULT 1,
    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_pref_version UNIQUE (pref_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pref_active ON user_preferences (pref_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_pref_user ON user_preferences (user_id) WHERE is_active;

-- ---------------------------------------------------------------------------
-- Append-only tables. These are their own history, so no version columns.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS water_logs (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    logged_on  date NOT NULL DEFAULT CURRENT_DATE,
    volume_ml  numeric NOT NULL CHECK (volume_ml > 0),
    source     entry_source NOT NULL DEFAULT 'manual',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_water_user_date ON water_logs (user_id, logged_on DESC);

-- Every message and every upload. Text, image, video, audio, pdf, and our
-- replies - one stream. Extraction is a STATUS on the row, not a jobs table.
CREATE TABLE IF NOT EXISTS communication_master (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    thread_id       uuid NOT NULL DEFAULT gen_random_uuid(),
    correlation_id  uuid NOT NULL DEFAULT gen_random_uuid(),

    direction       message_direction NOT NULL,
    msg_type        message_type NOT NULL,
    msg_text        text,          -- typed text, caption, transcript, or OUR reply
    media_url       text,
    media_meta      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- mime, bytes, duration_s, pages
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- extraction draft / tool calls
    status          message_status NOT NULL DEFAULT 'received',

    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comm_user_created ON communication_master (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comm_thread ON communication_master (thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comm_correlation ON communication_master (correlation_id);

-- Observability only. Different GRAIN from communication_master: one row per
-- agent execution, and a single photo can trigger three (the dispersion pass).
CREATE TABLE IF NOT EXISTS agent_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid REFERENCES app_users(id) ON DELETE CASCADE,
    correlation_id  uuid,
    agent_name      text NOT NULL,
    model           text,
    duration_ms     integer,
    input_tokens    integer,
    output_tokens   integer,
    cost_usd        numeric,
    status          text NOT NULL DEFAULT 'ok',
    error_message   text,
    output          jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_corr ON agent_runs (correlation_id);

-- The logging table. One shared log for every entity rather than a per-entity
-- log, so goals, meals, preferences and portions all log the same way and the
-- admin dashboard reads one place.
CREATE TABLE IF NOT EXISTS audit_log (
    id             bigserial PRIMARY KEY,
    entity         text NOT NULL,          -- 'goal' | 'meal' | 'preference' | 'portion'
    entity_id      uuid,
    user_id        uuid REFERENCES app_users(id) ON DELETE SET NULL,
    action         text NOT NULL,          -- CREATE | UPDATE | DELETE | VERSION
    old_value      jsonb,
    new_value      jsonb,
    changed_fields text[],
    actor          text,                   -- user id, 'system', or an agent name
    source         text,                   -- api | trigger | agent | seed
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id, created_at DESC);
