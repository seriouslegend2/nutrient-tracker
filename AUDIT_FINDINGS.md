# Repository Alignment Audit

Reconciled on 2026-08-16 after the remediation. Checked items are either fixed
in implementation or resolved by narrowing the documented product contract.
`(scoped in docs)` means the repository does not claim that capability is
shipped. Only verification that requires external credentials/runtime remains
unchecked.

## P0: Security And Runtime

- [x] Revoke default `PUBLIC`, `anon`, and `authenticated` execution from
  privileged `SECURITY DEFINER` functions; grant execution to `service_role`.
- [x] Validate customer Google OAuth continuation paths and the callback code
  exchange; force Google's account chooser for every customer auth attempt.
- [x] Fix the dashboard's post-login destination.
- [x] Apply and document the cookie options used by the Supabase SSR bridge.
- [x] Keep customer Google OAuth and dashboard sign-in server-side, make the
  dashboard sign-in-only, and retain logout in both applications.
- [x] Reconcile RLS with the service-role backend: repository scoping and RBAC
  are primary; RLS is defense in depth and is bypassed by backend calls.
- [x] Add a reproducible pgvector/Postgres migration and integration-test path.
- [x] Make CI require the database and fail on skipped tests.
- [x] Add `supabase/config.toml` and apply all migrations from empty in the
  Postgres integration suite.
- [x] Document permanent backend JWT behavior, server-only signing keys, and
  whole-secret rotation.
- [x] Record that the supplied service-role key was exposed, must be rotated,
  and must never have its value included in documentation or frontend config.

## P0: Core Customer Product Loop

- [x] Gate first-time customers into onboarding.
- [x] Validate required sex, birth date, height, and weight fields.
- [x] Offer goal preview/create immediately after onboarding and at `/goals/new`.
- [x] Implement manual dish search, free text, portions, meal edit, and delete.
- [x] Wire dish-portion and goal activate/deactivate BFF routes.
- [x] Keep manual onboarding, meals, goals, reports, and hydration usable without
  an OpenAI key; document media's disabled response and unavailable chat turns.
- [x] Add logout and shared client handling for unauthorized API responses.

## P0: Data Correctness And Safety

- [x] Make whole-day replacement atomic; media confirmation remains a reviewed
  batch without an all-or-nothing guarantee. `(scoped in docs)`
- [x] Preserve coherent day-version history for normal meal edits and deletes.
- [x] Make goal, preference, and portion version swaps atomic.
- [x] Compare `(meal_date, id)` for descending meal keyset pagination.
- [x] Clamp sub-800 nutrient requests consistently in preview and creation.
- [x] Implement target-BMI, pregnancy/nursing, and disclosed-medical guards.
- [x] Implement `behaviour` goal resolution and progress.
- [x] Recompute BMI/BMR/TDEE after structural profile changes.
- [x] Preserve stable logical dish IDs across versions.

## P1: AI And Media

- [x] Remove media-persistence/replay/admin-inspection promises. `(scoped in docs)`
- [x] Enforce upload byte limits; page and duration limits are deferred.
  `(scoped in docs)`
- [x] Route nutrition labels only from explicit wording or filename hints and
  document that this is not automatic classification.
- [x] Run three extraction samples for ordinary image uploads and report the
  resulting mass range.
- [x] Convert PDF rows into editable confirmation drafts before meal writes.
- [x] Reject video explicitly. `(scoped in docs)`
- [x] Remove any unsupported `read_media_in_detail` tool contract.
  `(scoped in docs)`
- [x] Persist `agent_runs` and create audit records for confirmed media imports.
- [x] Keep ambiguous chat turns read-only until an explicit mutation request or
  confirmation.

## P1: Customer Experience

- [x] Limit report claims to implemented day/week/month grouping, calorie and
  macro charts, micronutrient/RDA view, goal comparison, and weight history.
  `(scoped in docs)`
- [x] Limit editing claims to implemented onboarding and meal-saved portion
  corrections; a general profile/preferences editor is deferred.
  `(scoped in docs)`
- [x] Implement hydration target/progress logging and recent history.
- [x] Remove account export and deletion promises. `(scoped in docs)`
- [x] Describe the manifest accurately; offline/service-worker support is
  deferred. `(scoped in docs)`
- [x] Provide mobile camera capture and responsive customer layouts.

## P1: Internal Dashboard

- [x] Implement server paging and explicitly state that user search, filters,
  and sorting are unavailable. `(scoped in docs)`
- [x] Limit panel claims to overview, meals, goals, preferences, conversations,
  and agent runs. `(scoped in docs)`
- [x] Render supported panels with panel-specific summaries/tables rather than
  claiming unsupported profile-progress/audit views.
- [x] Implement aggregate agent and portion-resolution metrics; defer Food DB
  administration. `(scoped in docs)`
- [x] Gate the dashboard in the frontend and enforce admin permissions in FastAPI.
- [x] Document the operator-controlled `user_roles` admin grant after first sign-in.

## P1: Search, Seeds, And API Contracts

- [x] Describe dish search as normalized substring matching, not ranked lexical,
  semantic, or combined search. `(scoped in docs)`
- [x] Correct the optional seed to 61 curated dishes, 18 migrated category
  defaults, and no demo user.
- [x] Remove unsupported raw/cooked ETL guarantees from product documentation.
  `(scoped in docs)`
- [x] Remove the generated shared API-type-package contract. `(scoped in docs)`
- [x] Point setup to app-specific environment examples and keep the service-role
  key backend-only.
- [x] Keep checked-in project/public keys generic and explain that actual local
  environment files contain public project values plus placeholders for rotated
  service-role and JWT secrets.
- [x] Keep the documented customer and admin UI calls reachable through their
  same-origin BFF routes.

## Engineering Quality And Documentation

- [x] Ruff check and format check pass.
- [x] Mypy passes for the strict scope configured in `Makefile` and CI.
- [x] All four import-linter contracts pass.
- [x] Add focused frontend unit coverage for auth redirects, backend JWTs, API
  clients, pagination, and panel contracts.
- [x] Add real Playwright infrastructure for all non-agent customer and dashboard
  journeys, secure hosted-user provisioning, stable screenshots, and failure PDF
  evidence. The real hosted execution passed all 14 scenarios.
- [x] Update stack versions, migration count, seed size, and verification results.
- [x] Reconcile `README.md`, `PLAN.html`, `STATUS.html`, and `DAG.md` with the
  current implementation.
- [x] Restrict verified claims to commands run locally or behavior covered by
  checked-in tests.

## Current Verification Evidence

The following commands completed locally on 2026-08-16:

- Ruff check and format check: pass; 81 files already formatted.
- Configured mypy scope: pass with no issues in 12 source files.
- Import-linter: 4 contracts kept, 0 broken across 65 analyzed files.
- Full pytest run with required pgvector/Postgres 17 database: `98 passed in
  12.96s`; no skips; all 15 migrations applied from empty.
- Customer application: TypeScript pass and Next.js production build pass.
- Internal dashboard: TypeScript pass and Next.js production build pass.
- Customer Vitest suite: 31 passed; dashboard Vitest suite: 22 passed.
- Root E2E strict TypeScript check passed, evidence-report tests reported `3
  passed`, and Playwright statically discovered 15 hosted Chromium scenarios.
- Playwright Chromium completed the current real hosted non-agent suite against
  Supabase Auth/PostgREST and all three local services: `15 passed` in 2.3
  minutes, with 17 named screenshots and a 9-page HTML/PDF evidence report.
- Both frontend production dependency audits: 0 vulnerabilities after the
  Next.js 16.3.1 upgrade.
- Frontend isolation script: pass.

These are local command results, including a local browser run against hosted
Supabase. They are not evidence that a GitHub Actions run or hosted application
deployment succeeded.

## External Verification

- [ ] Rotate the exposed Supabase service-role key, generate a replacement
  shared JWT secret, and replace the local placeholders. Blocker: credential
  rotation and secret delivery must be completed by a Supabase project operator.
- [x] Apply the hosted schema and optional 61-dish seed to Supabase;
  validate required tables/RPCs through service-role PostgREST and exercise real
  Supabase sessions plus BFF-issued user JWTs.
- [ ] Enable the Supabase Google provider and complete hosted customer OAuth
  signup/login with account selection and callback exchange. Existing browser
  evidence predates the Google-only customer login change.
- [x] Complete dashboard sign-in/logout, denial without the `admin` role, and
  access after setup grants the role in `user_roles`.
- [ ] Verify direct authenticated-client own-row RLS behavior separately. The
  shipped BFF architecture intentionally performs product database calls with
  the backend service role.
- [x] Exercise live OpenAI and LangSmith calls for `media_facts` and the separate
  draft-only `media_meal_resolver` with both a real meal image and a generated food-diary
  PDF; an authenticated FastAPI acceptance run reviewed and confirmed all three
  resulting meal rows, read them back from hosted Supabase, and removed the
  temporary user afterward.
- [ ] Exercise a live audio transcription followed by a live `nutrition_chat`
  turn. The production route is wired and unit-covered, but this remaining path
  still needs an audio fixture and authenticated acceptance run.
- [x] Drive the baseline non-agent Playwright login/onboarding/goal/meal/water/
  report/profile/admin suite against hosted Supabase and all three configured
  services: 14 passed with screenshot and PDF evidence.
- [x] Re-run the 15-scenario suite after deploying the category-portion and
  multi-goal migrations; all scenarios passed and temporary users were removed.
