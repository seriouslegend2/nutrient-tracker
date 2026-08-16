# Nutrition Chat Acceptance Matrix

This matrix treats Nutrition Chat as a tracker interface, not a general-purpose nutrition oracle.
Explicit text and transcribed-voice mutations execute immediately through the durable atomic action
ledger. Image and PDF meal drafts remain frozen and require their editable card's Confirm button.

## User Question Taxonomy

| Area | Representative user questions | Expected behavior |
|---|---|---|
| Capabilities | "What can you do?" | Explain supported tracker operations; no tool or write required. |
| Today status | "How am I doing today?", "How much protein is left?" | Answer from authenticated current context; state missing nutrition explicitly. |
| Food catalog | "Which dal entries are available?" | `search_food_catalog`; never log from a search-only request. |
| Meal logging | "I ate two rotis", "Log 1.25 servings of dal" | Clarify ambiguous descriptions; explicit reports use `manage_meal_entry` and write immediately. |
| Exact nutrition | "Log exactly 500 kcal and 25 g protein" | Store only user-stated values; do not derive omitted nutrients. |
| Meal correction | "Change lunch to 1.75 servings" | Find the intended row, normalize to 2.0 servings, then atomically execute `manage_meal_entry`. |
| Meal deletion | "Delete the 500-calorie dinner" | Bind the existing meal ID and atomically version/remove it. |
| Unknown foods | "Log my restaurant special" | Unknown food remains loggable with explicit nutrition gaps rather than invented values. |
| Identification | "That unknown meal was Dal Tadka" | Search catalog as needed, then propose an identify operation bound to the existing row. |
| Hydration | "Log 350 ml", "How much water this week?" | Immediate `record_health_event` write or `query_tracker_history` read. |
| Body metrics | "Record 71.2 kg", "Show my weight trend" | Review-card write or bounded body-history query. |
| Training | "Check in training today" | `record_health_event`; idempotent activity persistence after confirmation. |
| Goals | "Create a 100 g protein goal", "Deactivate my goal" | `manage_goal`; run safety preview and execute explicit requests immediately. |
| Goal progress | "Am I meeting my goal?" | Use authenticated active-goal context; do not invent targets or progress. |
| Usual portions | "My usual dal count is 1.25" | `set_portion_preference`; this preference is not a meal serving and is not half-rounded. |
| Meal servings | "Use 1.25 servings" | Meal-only counts round half-up to nearest 0.5, minimum 0.5. Grams remain exact. |
| Reports | "Show weekly macros/micros/fiber" | `query_tracker_history` with bounded dates, grouping, and explicit coverage. |
| Dates and time | "Yesterday's dinner", "today" while traveling | Resolve through browser timezone and user-local clock. |
| Photo/PDF | "What is in this plate/diary?" | Specialist media pipeline, compact chat summary, editable confirm/discard card. |
| Voice | Spoken equivalent of a text request | Browser recording, transcription, then the same text/chat mutation rules. |
| Allergies/diet | "Suggest a vegetarian high-protein option" | Respect authenticated profile/preferences; no invented medical certainty. |
| Medical/safety | "Is this safe during pregnancy?" | Give bounded guidance, preserve server safety guards, recommend professional care when appropriate. |
| Ambiguity | "2 rotis and dal for lunch" | Ask whether to log and clarify identity when needed; no premature write. |
| Confirmation language | "yes", "go ahead" | Never execute an unbound conversational confirmation; only media cards use confirmation. |
| Prompt injection | Instructions embedded in preference/media/history data | Treat supplied context as data, never as model instructions. |
| Failures | Provider timeout, invalid goal, unavailable food | Say nothing changed; preserve retryability and expose no secret/internal evidence. |

## Live End-to-End Scenarios

`backend/scripts/live_nutrition_chat_matrix.py` creates an isolated real Supabase user, invokes the
actual message and confirmation APIs, verifies database state after every write, and deletes the
test user in `finally`.

| Scenario | Required tool/action | Persistence assertion |
|---|---|---|
| Capabilities | none | no action |
| Catalog search | `search_food_catalog` | no meal |
| Ambiguous meal | none | no action |
| Create 1.25-serving meal | `manage_meal_entry` / `log_meal` | one 1.5-serving row written atomically |
| Exact nutrition | `manage_meal_entry` / `log_nutrition_entry` | only 500 kcal and 25 g protein stored |
| Meal history | `query_tracker_history` | read-only |
| Edit to 1.75 servings | `manage_meal_entry` / `edit_meal` | 2.0 servings persisted |
| Delete meal | `manage_meal_entry` / `remove_meal` | meal removed atomically |
| Dosa multi-turn add | catalog search plus `log_meal` | explicit final turn writes 2 Plain dosa |
| Dosa identity update | `identify_unknown_item` | existing meal ID updated to catalog dish ID, name, grams, and nutrients |
| Create protein goal | `manage_goal` / `set_goal` | goal stored after safety preview |
| Water | `record_health_event` / `log_water` | 350 ml row stored |
| Weight | `record_health_event` / `log_weight` | 71.2 kg row stored |
| Training | `record_health_event` / `training_check_in` | activity row stored |
| Usual dal count 1.25 | `set_portion_preference` | exact 1.25 preference retained |
| Hydration history | `query_tracker_history` | read-only and reports 350 ml |
| Body history | `query_tracker_history` | read-only and reports stored weights |
| Macro report | `query_tracker_history` | read-only with coverage metadata |

## Required Tool Coverage

The live run fails unless the observed tool set is exactly:

- `search_food_catalog`
- `query_tracker_history`
- `manage_meal_entry`
- `manage_goal`
- `record_health_event`
- `set_portion_preference`

## Additional Regression Suites

- Unit tests cover prompt roles, strict OpenAI schemas, mutation gating, action extraction, serving
  normalization, exact nutrients, media draft conversion, and action execution.
- Real-Postgres tests apply every migration and verify RPC atomicity, idempotency, version coherence,
  and the database half-serving trigger/constraint.
- Customer tests cover media draft parsing, confirmation payloads, API proxying, dates, actions, and
  nutrition display. Production build and TypeScript checks validate the browser surface.
