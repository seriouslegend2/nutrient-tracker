# Repository Alignment Audit

Reconciled on 2026-08-16 after the remediation. Checked items are either fixed
in implementation or resolved by narrowing the documented product contract.
`(scoped in docs)` means the repository does not claim that capability is
shipped. Only verification that requires external credentials/runtime remains
unchecked.

## P0: Security And Runtime

- [x] Revoke default `PUBLIC`, `anon`, and `authenticated` execution from
  privileged `SECURITY DEFINER` functions; grant execution to `service_role`.
- [x] Validate customer email/password continuation paths and the optional
  email-confirmation callback; document that the dashboard needs no callback.
- [x] Fix the dashboard's post-login destination.
- [x] Apply and document the cookie options used by the Supabase SSR bridge.
- [x] Keep customer signup and dashboard sign-in server-side, make the dashboard
  sign-in-only, and retain logout in both applications.
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
  clients, pagination, and panel contracts; browser automation remains external
  verification work. `(scoped in docs)`
- [x] Update stack versions, migration count, seed size, and verification results.
- [x] Reconcile `README.md`, `PLAN.html`, `STATUS.html`, and `DAG.md` with the
  current implementation.
- [x] Restrict verified claims to commands run locally or behavior covered by
  checked-in tests.

## Current Verification Evidence

The following commands completed locally on 2026-08-16:

- Ruff check and format check: pass; 74 files already formatted.
- Configured mypy scope: pass with no issues in 12 source files.
- Import-linter: 4 contracts kept, 0 broken across 64 analyzed files.
- Full pytest run with required pgvector/Postgres 17 database: `68 passed in
  9.06s`; no skips; all 12 migrations applied from empty.
- Customer application: TypeScript pass and Next.js production build pass.
- Internal dashboard: TypeScript pass and Next.js production build pass.
- Customer auth Vitest suite: 27 passed; dashboard Vitest suite: 22 passed.
- Both frontend production dependency audits: 0 vulnerabilities after the
  Next.js 16.3.1 upgrade.
- Frontend isolation script: pass.

These are local parity commands, not evidence that a GitHub Actions run or a
hosted deployment succeeded.

## Externally Blocked Verification

- [ ] Rotate the exposed Supabase service-role key, generate a replacement
  shared JWT secret, and replace the local placeholders. Blocker: credential
  rotation and secret delivery must be completed by a Supabase project operator.
- [ ] Apply the 12 migrations to a real hosted Supabase project and exercise
  PostgREST, the `auth.users` bootstrap trigger, real JWT claims, and row-level
  policy behavior. Blocker: no linked project or Supabase credentials were
  available. The local suite uses Supabase-shaped Postgres stubs and does not
  prove hosted behavior.
- [ ] Enable the Supabase Email provider and complete live hosted customer
  email/password signup and signin. If email confirmations are enabled, also
  allow and exercise `http://localhost:3000/auth/callback`; otherwise no
  callback verification is needed. The sign-in-only dashboard never needs a
  callback. Blocker: hosted authentication has not been exercised.
- [ ] Complete dashboard sign-in/logout, denial without the `admin` role, and
  access after an operator grants that role in `user_roles`. Blocker: this
  depends on the hosted account and role grant above.
- [ ] Exercise live OpenAI calls for `nutrition_chat` and `media_extraction`
  across image, label-hinted image, audio, and PDF inputs. Blocker: no provider
  API credential was used; current evidence covers code paths with mocked
  provider output only.
- [ ] Drive the complete browser signup/onboarding/meal/report/admin flow against
  those external services. Blocker: it depends on the unverified hosted
  Supabase email authentication above, and no browser suite is checked in.
