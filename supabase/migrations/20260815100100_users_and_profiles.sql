-- Users, roles, and the body-metric time series.
--
-- IDENTITY RULE: app_users.id IS auth.users.id. There is no separate app-level
-- user id to keep in sync. A trusted caller passes this context after
-- authenticating to FastAPI with the shared backend bearer.
--
-- ROLES RULE: roles live in user_roles, NOT in Supabase user_metadata. A user
-- can update their own metadata, so a role stored there is self-assignable -
-- a straight privilege-escalation hole.

CREATE TABLE IF NOT EXISTS app_users (
    id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email         text,
    display_name  text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id  uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    role     app_role NOT NULL,
    granted_at timestamptz NOT NULL DEFAULT now(),
    granted_by uuid REFERENCES app_users(id),
    PRIMARY KEY (user_id, role)
);

-- ---------------------------------------------------------------------------
-- Profile: the CURRENT derived state. Not versioned - it is a cache recomputed
-- from body_metrics (which is already a time series) by fn_refresh_user_profile.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id        uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,

    -- questionnaire Q1-Q2
    sex            biological_sex,
    date_of_birth  date,

    -- Q3, Q5-Q6
    height_cm      numeric CHECK (height_cm > 0 AND height_cm < 300),
    waist_cm       numeric CHECK (waist_cm IS NULL OR waist_cm > 0),
    activity       activity_level NOT NULL DEFAULT 'moderate',

    -- Q7-Q9
    diet           diet_type,
    allergies      text[] NOT NULL DEFAULT '{}',
    breakfast_time time NOT NULL DEFAULT '08:00',
    lunch_time     time NOT NULL DEFAULT '13:30',
    dinner_time    time NOT NULL DEFAULT '20:30',

    -- safety gates (asked on the goal screen, never at signup)
    is_pregnant_or_nursing boolean NOT NULL DEFAULT false,
    has_medical_condition  boolean NOT NULL DEFAULT false,

    -- derived, written ONLY by fn_refresh_user_profile
    bmi            numeric,
    bmr_kcal       numeric,
    tdee_kcal      numeric,
    computed_at    timestamptz,

    onboarding_completed_at timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Append-only. One row per weigh-in IS the history, so no version columns.
CREATE TABLE IF NOT EXISTS body_metrics (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    measured_on date NOT NULL DEFAULT CURRENT_DATE,
    weight_kg   numeric NOT NULL CHECK (weight_kg > 0 AND weight_kg < 500),
    waist_cm    numeric CHECK (waist_cm IS NULL OR waist_cm > 0),
    source      text NOT NULL DEFAULT 'manual',
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The hot read is "latest weight for this user", served by this index.
CREATE INDEX IF NOT EXISTS idx_body_metrics_user_date
    ON body_metrics (user_id, measured_on DESC, created_at DESC);
