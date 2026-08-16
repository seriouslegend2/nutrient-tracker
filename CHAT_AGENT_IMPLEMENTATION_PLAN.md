# Nutrition Chat Orchestrator Implementation Plan

## Purpose

Build one customer-facing nutrition chatbot backed by a large, safe orchestration
system. The chat agent must understand the signed-in user's nutrition state,
answer questions from authoritative product data, coordinate specialist media and
food-resolution agents, and perform explicitly requested mutations without
inventing nutrition or duplicating writes.

This plan treats the chatbot as the top-level coordinator. Deterministic domain
services remain responsible for nutrition arithmetic, goal progress, serving
conversion, validation, persistence, and authorization.

## Implementation Status

The first end-to-end implementation is now present in the repository:

- Typed `NutritionContextSnapshot` with user-local clock, profile safety facts,
  preferences as untrusted data, household portions, today's meals/water/training,
  latest body metric, and every active goal without full calendars.
- Bounded read tools for today, goals, portions, hydration, body metrics, and
  deterministic nutrition reports.
- A real LangSmith `ChatPromptTemplate` with an identical checked-in fallback.
- Dedicated `ORCHESTRATION_MODEL`, defaulting to `gpt-5.4`.
- Durable, expiring, user-scoped, idempotent action proposals with fenced
  confirmation, execution, failure, and discard states.
- Structured customer confirmation cards for meal, nutrient, goal, water,
  weight, portion, unknown-item, training, and goal-management mutations.
- Text and transcribed audio use the same orchestrator; attached audio notes are
  preserved.
- Images and PDFs run both specialist stages before a compact, read-only chat
  handoff and retain the dedicated editable review card.
- Media confirmation is one database transaction and is idempotent across retries.
- Prompt, context, action, modality, database, customer, and build verification.

Remaining release work is operational: deploy the new migration/backend/customer
build, publish and pin the approved LangSmith prompt revision, run live-provider
chat/audio/media evaluations, and monitor the limited rollout.

## Scope Assumption

The current product's "household" data means one signed-in user's usual category
serving counts. It does not contain household members with separate profiles,
permissions, goals, or meal allocations. This implementation covers the complete
signed-in-user experience. True multi-member households require a separate data
model and are outside this plan.

## Existing Architecture

The repository already contains four cooperating agents and one transcription
service:

| Component | Current responsibility |
| --- | --- |
| `nutrition_chat` | Text conversation, bounded reads, and gated mutations |
| `media_facts` | Structured facts and quantities from supported images and PDFs |
| `media_meal_resolver` | Map media facts to catalog dishes or create a catalog dish |
| `manual_meal_resolver` | Resolve unmatched typed meal names after direct logging |
| Speech-to-text | Convert supported audio to plain text before chat |

Current entry paths:

```text
Text -> nutrition_chat

Audio -> speech-to-text -> nutrition_chat

Image/PDF -> media_facts -> media_meal_resolver
          -> deterministic serving draft -> customer review

Unknown typed meal -> meal service -> manual_meal_resolver
```

The main gaps are incomplete user context, limited read tools, heuristic text
confirmation, non-atomic media confirmation, model-authored tool summaries,
mutable prompt deployment, and no live end-to-end chat evaluation suite.

## Target Architecture

```text
Customer message
  -> authenticated message router
  -> modality router
  -> specialist preprocessing when required
  -> typed NutritionContextSnapshot
  -> nutrition_chat orchestrator
  -> bounded read tools or proposed mutation
  -> deterministic domain service / atomic RPC
  -> authoritative tool result
  -> persisted response, action ledger, audit, and telemetry
```

Modality behavior:

| Input | Required flow |
| --- | --- |
| Text | Run the nutrition orchestrator directly |
| Audio | Transcribe without an instruction prompt, preserve any attached note, then run the same text orchestrator |
| Image/PDF | Run media facts, media resolution, and deterministic draft construction before giving the orchestrator a compact pending-draft event |
| Unsupported media | Reject before invoking an agent and return a typed customer error |

The orchestrator must not absorb specialist extraction logic. It coordinates the
specialists and explains their authoritative outputs to the customer.

## Phase 1: Typed Context Foundation

Create a request-scoped `NutritionContextSnapshot` and load it once per customer
turn. Do not rebuild profile and goal strings before every model call.

Suggested top-level contract:

```json
{
  "clock": {},
  "profile": {},
  "preferences": [],
  "portion_categories": [],
  "today_date": "YYYY-MM-DD",
  "today_meals": [],
  "today_totals": {},
  "today_water": {},
  "today_training_checked_in": false,
  "latest_body_metric": null,
  "active_goals": [],
  "conversation": [],
  "current_user_input": ""
}
```

### Clock

Include:

- User timezone.
- User-local ISO date and time.
- UTC timestamp.
- Relative-date interpretation boundary for words such as today and tomorrow.

Add a timezone field to the user profile or account settings. The browser should
send its IANA timezone during onboarding/profile updates, and the backend should
validate it. Server `date.today()` and database `CURRENT_DATE` must not determine
the user's conversational day without timezone conversion.

### Persona and Safety

Include:

- Display name.
- Onboarding completion state.
- Age or date of birth.
- Sex, height, latest weight, and latest waist measurement.
- Activity level, diet, allergies, and preferred meal times.
- BMI, BMR, TDEE, and their computation timestamp.
- Pregnancy/nursing flag.
- Medical-condition flag.
- Explicit data gaps.

Safety flags must be structured data, not prose hidden in a system prompt. The
agent must not diagnose or provide condition-specific clinical treatment.

### Preferences

Load only active and unexpired preferences. Include type, expiry, source, and
version. Treat preference titles and content as untrusted user data, never as
system instructions.

### Household Portions

Inject the compact category catalog because it is bounded. Include:

- Category.
- Fixed unit and grams per unit.
- User's usual count.
- Effective usual grams.
- Whether the count is customized.
- Source/version when relevant.

Do not describe the usual count as changing the fixed global serving definition.

### Today Snapshot

Compute authoritative values in application code:

- Meals grouped by slot.
- Calories, protein, carbohydrates, fat, fiber, and available micronutrients.
- Count and names of nutrition-unknown items.
- Water total.
- Training check-in state.
- Latest body measurement.
- Data coverage and truncation indicators.

The model must never sum raw meal rows when a deterministic total is available.

### Active Goal Snapshot

Include every active goal, not only the primary goal. Each goal should provide:

```json
{
  "goal_id": "uuid",
  "kind": "nutrient",
  "cadence": "daily",
  "starts_on": "2026-08-01",
  "ends_on": "2026-11-01",
  "is_primary": false,
  "targets": [
    {
      "metric": "protein_g",
      "direction": "at_least",
      "unit": "g",
      "today": {
        "actual": 42,
        "target": 70,
        "remaining": 28,
        "status": "in_progress"
      },
      "tomorrow": {
        "target": 70
      },
      "period": {
        "actual": 820,
        "target": 1050,
        "remaining": 230
      }
    }
  ],
  "days_remaining": 15,
  "safety_derivation": {}
}
```

For `around` goals, expose lower and upper bounds plus distance to the valid band.
Do not represent them as a misleading single remaining value. Tomorrow has a
target but no achieved amount until that local day starts.

Do not automatically inject complete goal calendars. Provide bounded calendar
retrieval only when the customer asks for date-level history.

## Phase 2: Authoritative Read Tools

Current-state facts are injected once per turn. Keep only bounded on-demand tools:

| Tool | Responsibility |
| --- | --- |
| `search_food_catalog` | Bounded compact candidate retrieval; never inject the full catalog |
| `query_tracker_history` | Bounded historical meals, nutrition, hydration, or body metrics |

The mutation surface is four model-facing tools with separate internal action types:

| Tool | Responsibility |
| --- | --- |
| `manage_meal_entry` | Create catalog/free-text or exact-nutrition entries; update, identify, or delete meals |
| `manage_goal` | Create, activate, deactivate, or make a goal primary |
| `record_health_event` | Water, weight, or training events |
| `set_portion_preference` | Change a customer's usual fixed-unit count |

Every read tool must enforce user identity from runtime context, validate date
ranges, cap output size, and report truncation rather than silently dropping rows.

### Dish Retrieval

Do not inject the complete global dish universe into the chat prompt. Replace the
current fetch-all-and-filter search with database retrieval:

1. Exact normalized name and alias match.
2. Trigram and text-search candidates using existing indexes.
3. Optional embedding recall for transliteration or semantic variants.
4. Deterministic reranking and a small top-k result.
5. Full nutrition fetch only for selected dish IDs.

The complete catalog may remain available to a short-lived specialist resolver
only until that resolver is migrated to the same bounded candidate process.

## Phase 3: Mutation and Confirmation Model

Add a persisted `agent_actions` or `pending_operations` table. Suggested fields:

- Stable operation ID.
- User, thread, correlation, and inbound message IDs.
- Tool/action name.
- Validated immutable arguments.
- Customer-readable summary.
- Status: proposed, confirmed, executing, completed, failed, expired, discarded.
- Expiry timestamp.
- Idempotency key.
- Confirmation and execution timestamps.
- Result payload and safe error code.
- Audit and created/updated timestamps.

Mutation rules:

- Explicit, fully specified, low-risk logs may execute immediately with an
  idempotency key.
- Ambiguous meals require clarification or a persisted proposal.
- User-stated numeric nutrition requires a persisted confirmation.
- Safety-clamped goals require confirmation of the applied target.
- Media drafts always require review.
- A confirmation identifies one operation ID; a generic `yes` cannot unlock all
  mutation tools.
- Retries return the original completed result instead of duplicating a write.
- Actual tool messages and persisted action results form the execution ledger.
  The model does not authoritatively report which tools ran.

Add atomic database operations for multi-row media confirmation and any compound
mutation. Message status, resulting records, and idempotency state must commit or
roll back together.

## Phase 4: Mutation Tools

Support these customer operations through validated domain services:

- Log a resolved meal.
- Log an unresolved serving-only meal.
- Log exact customer-stated nutrients.
- Edit meal serving count.
- Remove a meal item.
- Resolve an unknown meal identity.
- Log water for the user's local date.
- Log weight and waist measurement.
- Create every supported goal type through preview and safety resolution.
- Activate, deactivate, or make a goal primary.
- Record or remove a training check-in.
- Change a category's usual serving count.
- Store or retire a durable preference after explicit consent.
- Confirm or discard a pending action.

All tools require strict Pydantic bounds, finite numbers, enum inputs, bounded
dates, explicit source provenance, and typed errors.

## Phase 5: Media and Audio Integration

### Image and PDF

Required sequence:

1. Validate MIME, signature, byte size, and empty files.
2. Run `media_facts`.
3. Run `media_meal_resolver`.
4. Build deterministic serving and nutrition draft data.
5. Persist the pending draft.
6. Give `nutrition_chat` a compact `MediaDraftContext` event.
7. Return both an assistant explanation and the review card.
8. Confirm through one atomic, idempotent operation.
9. Add a compact confirmed/discarded event to conversation history.

Do not append the full raw media payload to ordinary conversation text. Confirmed
or discarded drafts must never be described as pending. Prevent a later text
confirmation from bypassing the dedicated media confirmation endpoint.

Catalog dish creation during media analysis should either be staged until
confirmation or explicitly tracked as a separate audited operation.

### Audio

Required sequence:

1. Validate MIME, signature, size, and duration where available.
2. Transcribe without an instruction prompt.
3. Preserve any customer note alongside the transcript.
4. Persist transcription model and timing telemetry.
5. Send the normalized transcript through the same text orchestrator.

## Phase 6: LangSmith Chat Prompt Template

Publish `nutrition-chat-v1` as an actual `ChatPromptTemplate`, not a plain prompt
whose text is extracted and reconstructed by the application.

Required message structure:

```text
System:
  Stable role, nutrition provenance, safety boundaries, tool policy,
  mutation policy, and response requirements.

Context data message:
  Typed NutritionContextSnapshot, explicitly marked as untrusted data.

Conversation:
  Approved summary plus bounded recent messages.

User:
  Current text or transcript.

Tool messages:
  Authoritative read and execution results.
```

Runtime requirements:

- Preserve and execute the pulled chat template with `aformat_messages()`.
- Validate required roles and variables before accepting a remote prompt.
- Keep a structurally identical checked-in fallback.
- Pin production to an approved prompt commit or release tag.
- Cache the last-known-good prompt.
- Add pull timeout and failure backoff.
- Persist prompt name, source, and commit in `agent_runs`.
- Never combine one remote prompt role with a fallback role from another version.

## Phase 7: Model and Runtime Policy

Recommended allocation:

| Component | Initial model policy |
| --- | --- |
| Nutrition orchestrator | `gpt-5.4` |
| Media facts | Keep `gpt-4.1-mini` pending evaluations |
| Media meal resolver | Keep `gpt-4.1-mini` pending evaluations |
| Manual meal resolver | Keep `gpt-4.1-mini` pending evaluations |
| Audio | Keep the dedicated transcription model |

Add a dedicated `ORCHESTRATION_MODEL` setting rather than changing all specialist
models together. Configure explicit request timeout, retry budget, maximum output
tokens, maximum tool calls, per-tool timeout, recursion limit, and total turn
deadline.

The model may plan and explain. It must not calculate authoritative nutrition,
serving conversions, goal progress, or write outcomes.

## Phase 8: Conversation Memory

Replace fixed replay of the latest 30 database rows with:

- Bounded recent turns.
- A versioned conversation summary.
- Explicit pending-action state.
- Status-aware media events.
- Retrieval of older details only when required.

Do not store instructions inferred from conversation as permanent preferences
without explicit customer consent. Provide customer-visible correction and
retirement of saved preferences.

## Phase 9: Customer Experience

Keep the surface simple even though the backend is large:

- One conversation timeline.
- Streaming or progressive status for long operations.
- Structured proposal cards.
- Explicit confirm and discard actions.
- Media draft review cards.
- Clear summaries such as `28 g protein remaining today`.
- Visible unknown-nutrition coverage.
- Recovery state for interrupted turns.
- No raw tool JSON in customer messages.

The assistant should explain only the relevant result, not expose the internal
agent topology unless the customer asks.

## Phase 10: Observability and Privacy

Persist and trace:

- User-safe correlation and thread IDs.
- Agent/stage name.
- Actual provider-returned model.
- Prompt name, source, and pinned commit.
- Context version and approximate size.
- Actual tool calls and results.
- Action and idempotency IDs.
- Technical execution status and separate business outcome.
- Input/output tokens, calculated cost, and latency.

Do not send raw media bytes, base64, credentials, complete private records, or
unbounded payloads to LangSmith. Add trace-redaction tests and define retention
rules before production rollout.

## Phase 11: Tests and Evaluations

### Unit and Integration Tests

- Context snapshot includes every required field and marks missing data.
- User-local today/tomorrow behavior across timezone boundaries.
- Remaining-value semantics for `at_least`, `at_most`, and `around` goals.
- All active goals remain independent.
- Dish retrieval ranking and bounded output.
- Tool input bounds and user scoping.
- Unknown food remains honest when resolution fails.
- Manual resolver handoff for unmatched text meals.
- Media stage order and compact chat handoff.
- Audio note and transcript preservation.
- Persisted action confirmation and expiry.
- Idempotent retries and concurrent confirmation.
- Atomic multi-item media confirmation rollback.
- Safety-clamped goal consent.
- Stored preference prompt-injection resistance.
- Actual tool ledger matches persisted results.
- Prompt commit pinning and fallback compatibility.
- LangSmith traces contain no media bytes or base64.

### Browser End-to-End Tests

- `Today for dinner I had two rotis and dal` logs the resolved meal once.
- Ambiguous meal details produce a proposal instead of a guessed write.
- Unknown dish invokes the resolver and reports unresolved state honestly on
  failure.
- Calories, protein, carbs, fat, hydration, weight, and training goals can all be
  discussed independently.
- The agent correctly reports today, tomorrow, and period progress.
- Water, weight, training, meal edit, and meal delete operations work.
- Image and PDF uploads produce review cards and atomic confirmation.
- Audio follows the same intent and mutation rules as typed text.
- Logout/session expiry clears sensitive cached conversation state.

### LangSmith Evaluation Dataset

Include representative cases for:

- Read-only questions.
- Explicit and ambiguous mutations.
- Confirmation and refusal turns.
- Long conversations.
- Multiple active goals.
- Unknown dishes and partial nutrition coverage.
- Allergies and safety flags.
- Malicious preference content.
- Tool errors, timeouts, and retries.
- Media drafts in pending, confirmed, and discarded states.

Prompt and model promotion must be gated on tool correctness, mutation safety,
answer grounding, latency, and cost thresholds.

## Phase 12: Rollout

1. Add `NUTRITION_CHAT_V2` and `ORCHESTRATION_MODEL` feature controls.
2. Build context and read tools without changing writes.
3. Run offline regression tests and LangSmith evaluations.
4. Shadow the new context/orchestrator for internal accounts without executing
   duplicate tools.
5. Enable durable actions and atomic confirmation for internal accounts.
6. Pin the approved LangSmith prompt commit.
7. Roll out to a small customer cohort.
8. Monitor latency, token cost, tool errors, confirmation rates, unresolved-food
   rates, and duplicate-prevention events.
9. Expand only after the evaluation and operational gates pass.

## Planned File Areas

Expected primary changes:

- `backend/app/api/v1/messages_router.py`
- `backend/app/agents/runtime_context.py`
- `backend/app/agents/nutrition_chat/agent.py`
- `backend/app/agents/nutrition_chat/middleware.py`
- `backend/app/agents/nutrition_chat/models.py`
- `backend/app/agents/nutrition_chat/prompt.py`
- `backend/app/agents/nutrition_chat/runner.py`
- `backend/app/agents/nutrition_chat/state.py`
- `backend/app/agents/nutrition_chat/tools.py`
- New typed context/action modules under `backend/app/agents/nutrition_chat/`
- `backend/app/services/prompts.py`
- `backend/scripts/publish_prompts.py`
- Goal, meal, profile, report, water, and dish domain services
- A new ordered Supabase migration for timezone/action/idempotency support
- `customer-app/src/components/agent-client.tsx`
- New structured action components under `customer-app/src/components/`
- Backend, customer, database, and Playwright tests

## Completion Criteria

The work is complete when:

- One chat surface handles text, audio, images, and PDFs through the correct
  specialist sequence.
- The orchestrator receives compact authoritative profile, safety, serving,
  today, and all-goal context.
- Historical and catalog data use bounded tools rather than prompt dumps.
- Every mutation is validated, user-scoped, auditable, and idempotent.
- Confirmation is bound to one persisted operation.
- Media confirmation is atomic.
- Confirmed meal mutations and action-ledger completion are atomic.
- Goal answers correctly describe today, tomorrow, and period state.
- The production prompt is a pinned LangSmith `ChatPromptTemplate` with a tested
  local fallback.
- Actual tool execution, prompt provenance, tokens, cost, and latency are
  observable without exposing media bytes or secrets.
- Unit, database integration, browser E2E, and LangSmith evaluation gates pass.
