# Nutrient Tracker

Nutrient Tracker is a multi-user calorie and nutrition tracker with a FastAPI API,
a mobile-first Next.js customer application, an internal Next.js dashboard, and a
Supabase/Postgres database.

## Current Product

The implemented customer flow includes:

- Customer email/password signup and login through Supabase Auth, logout, and
  required first-run onboarding.
- Manual meal logging by date and meal type, substring dish search, free-text
  fallback, portion resolution, and version-preserving edit/delete operations.
- Goal preview and creation for nutrient, body-weight, item, hydration, and
  behaviour goals, including calorie floors, rate clamps, BMI checks, and
  pregnancy/medical-condition guards.
- Daily calorie/macro totals, goal progress, hydration logging/history, weight
  history, and day/week/month charts for calories, macros, micronutrients, and
  goal-versus-actual values.
- An optional `nutrition_chat` agent for conversational reads and explicitly
  confirmed mutations.
- An optional `media_extraction` agent for food photos, explicitly identified
  nutrition-label photos, audio transcription, and food-diary PDF extraction.
  Extracted meal rows are editable drafts and are not written until confirmed.
- A paginated, admin-gated dashboard with user overview, meals, goals,
  preferences, conversations, agent runs, aggregate agent metrics, and portion
  resolution metrics.

The backend exposes OpenAPI at `http://localhost:8000/docs`. List APIs use a
shared paginated envelope; meals also support a `(meal_date, id)` cursor.

## Architecture

```text
browser
  -> same-origin Next.js pages and /api routes
  -> FastAPI /api/v1 routes
  -> one server-side Supabase service-role client
  -> Postgres
```

`backend/` is the only application that accesses product tables. The frontends
use `@supabase/ssr` only for server-side authentication and session refresh;
application data always goes through their route-handler BFFs and FastAPI.
`scripts/check-frontend-isolation.sh` enforces that source boundary.

Authentication has two stages:

1. The customer BFF handles email/password signup and login. If hosted email
   confirmation is enabled, only the customer callback exchanges the
   confirmation code. The dashboard is sign-in-only for existing accounts and
   does not need a callback. Both apps support logout. Their server-side
   Supabase session bridges keep auth tokens in `httpOnly`, `sameSite=lax`, and
   production-`secure` cookies; no service-role key is present in either
   frontend.
2. Before proxying a protected request, the BFF verifies the Supabase user and
   signs a user-specific HS256 bearer containing `user_id`. FastAPI verifies that
   bearer and loads the user's roles from `user_roles`; token-supplied roles are
   not trusted for authorization.

FastAPI uses `SUPABASE_SERVICE_ROLE_KEY`, so its database calls bypass RLS.
User-id scoping in repositories and backend RBAC are therefore the primary
application authorization controls. RLS remains enabled as defense in depth for
other database access paths; it is not evaluated for service-role backend calls.

The generated BFF bearers have no expiry claim. Rotating `JWT_SECRET_KEY` and
both `BACKEND_JWT_SECRET` values invalidates all of them at once. Keep this shared
secret server-only and at least 32 bytes.

## Repository Map

```text
backend/app/
  api/v1/                 FastAPI routers, including admin routes
  agents/
    nutrition_chat/       tool-using conversational agent
    media_extraction/     LangGraph media normalization agent
  core/                   auth, RBAC, pagination, errors
  domain/                 meals, dishes, goals, profile, reports, water, admin
  services/               Supabase client, media provider I/O, identity
customer-app/             Next.js customer UI and same-origin BFF routes
internal-dashboard/       Next.js admin UI and same-origin BFF routes
supabase/migrations/      12 ordered SQL migrations
seeds/seed_dishes.py      optional 61-dish curated starter seed
```

## Prerequisites

| Tool | Supported baseline |
|---|---|
| Python | 3.13+ |
| `uv` | current release |
| Node.js | 22+ |
| Supabase CLI | current release |
| Docker | only for the Postgres integration suite |
| Playwright Chromium | installed by `make e2e-install` |

The checked-in lockfiles currently resolve FastAPI 0.141.1, Pydantic 2.13.4,
Supabase Python 2.31.0, LangChain 1.3.15, LangGraph 1.2.11, Next.js 16.3.1,
React 19.2.8, and Recharts 2.15.4.

## Configuration

Use the app-specific examples. Do not copy the root environment reference into
an application.

```bash
cp backend/.env.example backend/.env
cp customer-app/.env.example customer-app/.env.local
cp internal-dashboard/.env.example internal-dashboard/.env.local
```

- `backend/.env` contains `SUPABASE_SERVICE_ROLE_KEY` and must remain backend-only.
- Both frontend files contain the public Supabase Auth configuration plus the
  server-only `BACKEND_API_URL` and `BACKEND_JWT_SECRET`.
- `JWT_SECRET_KEY` in the backend must exactly match `BACKEND_JWT_SECRET` in both
  BFFs.
- `OPENAI_API_KEY` is optional. Manual onboarding, meals, goals, reports, and
  hydration remain usable without it; media reports that AI is disabled and
  the chat assistant cannot complete turns.
- A supplied service-role key was exposed and must be rotated in Supabase before
  it is used. Never commit, publish, or paste its value into documentation.
- The actual local environment files currently contain public project values
  and placeholders for the rotated service-role key and replacement JWT secret.
  Replace the placeholders after rotation; the checked-in examples deliberately
  remain generic.

### Supabase Email Authentication

For a hosted Supabase project:

1. In Supabase Auth providers, enable the Email provider and permit email/password
   signup.
2. Choose whether hosted email confirmation is required. With confirmations
   disabled, successful customer signup can create a session immediately.
3. Only when confirmations are enabled, add
   `http://localhost:3000/auth/callback` to Supabase Auth URL Configuration and
   add the deployed customer callback before production use. The confirmation
   link returns there for a server-side code exchange.
4. Do not add a dashboard callback. The dashboard has no signup or confirmation
   route; administrators sign in with an existing account created through the
   customer application.

After customer signup or first login, the auth-user bootstrap creates the
application user and customer role. The customer app then requires first-run
onboarding before protected product pages are used. Grant dashboard access
separately as described below.

## Install And Run

```bash
make setup
supabase link --project-ref YOUR_PROJECT_REF
make migrate
make seed       # optional curated starter dishes; reruns create new versions
make dev
```

| Service | URL |
|---|---|
| Customer application | `http://localhost:3000` |
| Internal dashboard | `http://localhost:3001` |
| FastAPI/OpenAPI | `http://localhost:8000/docs` |

The API requires a reachable Supabase project during startup. `make dev` does
not start Supabase or Postgres.

### Grant An Admin Role

Sign in once so the auth-user bootstrap creates the application user, then run
the following in the Supabase SQL editor using an appropriately privileged
operator:

```sql
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'admin'::public.app_role
FROM public.app_users
WHERE email = 'you@example.com'
ON CONFLICT (user_id, role) DO NOTHING;
```

Roles are stored in `user_roles`, not user-editable Supabase metadata.

## Data And Goal Model

Logged portions resolve in this order, and `resolved_from` records the result:

```text
meal value -> user's dish override -> user's category override
           -> global dish default -> global category default -> unknown
```

Unknown nutrition remains an empty vector and is reported as unaccounted rather
than counted as zero. Energy is recomputed from macros. Meal days, goals,
preferences, and portion overrides use database functions for atomic version
swaps. Body metrics and structural profile changes refresh derived BMI/BMR/TDEE
and can re-version the active goal.

## Verification

Run the repository's normal checks:

```bash
make check
```

### Real Hosted Browser E2E

The root Playwright suite exercises real running services and real hosted
Supabase Auth/PostgREST data. It does not intercept or mock product API calls.
Agent, conversation, upload, and media-extraction pages are deliberately outside
the suite. Runtime traces, videos, and JSON results are ignored; named full-page
screenshots and the final evidence HTML/PDF under `artifacts/` are commit-eligible.

Install Chromium and run schema-independent checks:

```bash
make e2e-install
make e2e-check
```

For a hosted run, start the customer app on `:3000`, dashboard on `:3001`, and
FastAPI on `:8000`, then export credentials without writing them to a repository
file:

```bash
export SUPABASE_URL='https://PROJECT_REF.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='...'
export E2E_EMAIL='kaushal@kookar.in'
export E2E_PASSWORD='...'
make e2e
```

`E2E_CUSTOMER_URL`, `E2E_DASHBOARD_URL`, and `E2E_BACKEND_URL` can override the
localhost defaults. Application-specific runtime configuration is still required
by the three services as documented above.

The secure global setup uses Supabase Auth Admin to find or create and confirm
`E2E_EMAIL`, updates its password to `E2E_PASSWORD`, ensures the application
identity/customer role, and grants the admin role through service-role
PostgREST. It also creates a deterministic `+nutrient-e2e-non-admin` auth alias
with the same supplied password and explicitly removes its admin role for the
dashboard-denial test. No password or service key is persisted. The primary E2E
account's `onboarding_completed_at` is reset before each run so required
onboarding is exercised; use a dedicated test account because the journey also
creates goals, meals, hydration, weight, profile, and portion records.

Setup probes all required product tables and non-agent RPCs before opening the
apps. A missing hosted migration fails with the table/RPC and migration filename
instead of producing misleading browser failures. The optional curated dish
scenario is reported as skipped when seed rows do not exist; free-text meal
coverage remains mandatory.

`npm run e2e` is an orchestrator: Playwright's exit code remains authoritative,
but report generation runs even after setup or scenario failure. It emits
`artifacts/e2e-report.html` and `artifacts/e2e-report.pdf` with scenario status,
sanitized environment/project reference, failures, timestamp, and embedded
screenshots. It never turns a failed hosted run into a passing one.

The checked-in evidence was generated on 2026-08-16 from a successful real run:
all 14 non-agent scenarios passed in 1.8 minutes, producing 16 named screenshots
and the 8-page `artifacts/e2e-report.pdf`. The two provisioned auth users were
deleted after verification.

Normal push and pull-request CI does not access hosted secrets. The
`workflow_dispatch` input `run_hosted_e2e` opt-in starts all three services only
after checking the required repository secrets, runs Chromium, and uploads the
evidence even on failure.

Run the full database suite in the same shape used by CI:

```bash
docker run --rm -d --name nt-verify \
  -e POSTGRES_PASSWORD=x pgvector/pgvector:pg17
(cd backend && NT_REQUIRE_DATABASE=1 NT_FAIL_ON_SKIP=1 uv run pytest -q)
docker stop nt-verify
```

On 2026-08-16, that complete suite applied all 12 migrations to an empty
Supabase-shaped Postgres 17 database and reported `69 passed`. The customer auth
test suite reported `27 passed`, the dashboard suite reported `22 passed`, and
`npm audit --omit=dev` reported zero production vulnerabilities in each
frontend. See `STATUS.html` for the other commands run and the exact boundary of
that evidence.

## Current Limitations

- Dish search is normalized substring matching. There is no shipped ranking,
  BM25, embedding, or combined lexical/vector retrieval.
- The optional seed is 61 curated dishes plus 18 category defaults from a
  migration. It does not include a demo user or a complete food corpus.
- Video uploads are rejected. Images are limited to 10 MB, audio to 25 MB, and
  PDFs to 20 MB; page and audio-duration limits are not implemented.
- Upload bytes are sent to the provider for the request but are not stored.
  Message metadata and extraction output are persisted, so raw-media replay or
  later visual inspection is unavailable.
- PDF extraction uses one selected confirmation date and meal type for the
  reviewed batch; it is not a general document archive/import system.
- Nutrition-label routing depends on explicit user wording or filename hints;
  it is not automatic image classification.
- The customer app has a web manifest but no service worker/offline mode. It has
  no account export or self-service account deletion.
- There is no dedicated post-onboarding profile/preferences editor. Meal
  corrections can save per-dish portions, and the backend exposes additional
  preference and portion endpoints.
- The dashboard intentionally has no user search/filter/sort, food-database
  editor, body-history/audit panels, or account mutation tools.
- Frontend types are maintained locally; no generated OpenAPI client/type
  package is checked in.
- Both frontends have focused Vitest coverage for redirect validation, backend
  JWT generation, API clients, pagination, and dashboard panel contracts. The
  checked-in Playwright suite and evidence cover real hosted non-agent browser
  flows. Self-service email confirmation, direct-client RLS, and live OpenAI
  provider calls remain separate verification work.

This is a nutrition tracking tool, not medical advice. Safety rules refuse or
clamp risky goals but do not replace clinical guidance.
