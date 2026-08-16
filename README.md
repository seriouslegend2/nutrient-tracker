# Nutrient Tracker

**Demo video:** [Watch on YouTube](https://youtu.be/iMKGnQBu9dc) · [Backup on Google Drive](https://drive.google.com/file/d/1cJqmfmqPshf8M0nfz8Ci_6Cw4LRsZ-PK/view?usp=drive_link)

Nutrient Tracker is a multi-user nutrition tracker with:

- a FastAPI backend on port `8000`;
- a mobile-first Next.js customer app on port `3000`;
- a Next.js internal dashboard on port `3001`;
- Supabase Auth and PostgreSQL;
- optional OpenAI and LangSmith integrations for chat, voice, images, and PDFs.

All product-data access goes through FastAPI. The Next.js applications use
Supabase only for server-side authentication and proxy product requests through
their same-origin `/api` route handlers.

## Repository Structure

```text
nutrient-tracker/
├── backend/                       FastAPI application and Python environment
│   ├── app/
│   │   ├── agents/                Nutrition chat and specialist media resolvers
│   │   ├── api/v1/                Customer and admin HTTP routes
│   │   ├── config/                Runtime settings
│   │   ├── core/                  Auth, RBAC, errors, pagination, middleware
│   │   ├── domain/                Meals, dishes, goals, profile, water, reports
│   │   ├── router_registry/       FastAPI route registration
│   │   ├── services/              Supabase, prompts, speech, media draft logic
│   │   └── main.py                FastAPI entry point
│   ├── scripts/                   Prompt publishing and live agent verification
│   ├── tests/                     Backend unit and database integration tests
│   ├── .env.example               Backend-only environment template
│   └── pyproject.toml              Python dependencies and tooling
├── customer-app/                  Customer Next.js application
│   ├── app/                       Pages and same-origin BFF route handlers
│   ├── src/components/            Customer UI
│   ├── src/lib/                   API client, auth, nutrition helpers
│   └── .env.example               Customer environment template
├── internal-dashboard/            Admin Next.js application and BFF
│   └── .env.example               Dashboard environment template
├── supabase/
│   ├── migrations/                22 ordered PostgreSQL migrations
│   └── config.toml                Local Supabase configuration
├── seeds/seed_dishes.py           Optional curated food seed
├── e2e/                           Hosted Playwright journeys
├── scripts/                       Repository boundary checks and token helper
├── Makefile                       Main development commands
├── package.json                   Root Playwright tooling only
└── .env.example                   Environment reference; do not copy into an app
```

## Architecture

```text
Browser
  -> Next.js page
  -> same-origin Next.js /api route (BFF)
  -> FastAPI /api/v1
  -> server-side Supabase service-role client
  -> PostgreSQL
```

The browser never receives `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET_KEY`, or
`BACKEND_JWT_SECRET`.

## Prerequisites

Install:

- Python `3.13+`
- [`uv`](https://docs.astral.sh/uv/)
- Node.js `22+` and npm
- Docker, if running Supabase locally or the database integration environment
- Supabase CLI through `npx supabase` (no global installation is required)

## First-Time Setup

From the repository root:

```bash
make setup

cp backend/.env.example backend/.env
cp customer-app/.env.example customer-app/.env.local
cp internal-dashboard/.env.example internal-dashboard/.env.local
```

`make setup` installs the backend, both Next.js applications, and root
Playwright dependencies. It does not start or configure Supabase.

### Required Environment Values

`backend/.env`:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_SERVICE_ROLE_KEY
JWT_SECRET_KEY=ONE_SHARED_SECRET_AT_LEAST_32_BYTES
```

Both `customer-app/.env.local` and `internal-dashboard/.env.local`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
BACKEND_API_URL=http://localhost:8000
BACKEND_JWT_SECRET=ONE_SHARED_SECRET_AT_LEAST_32_BYTES
```

`JWT_SECRET_KEY` and both `BACKEND_JWT_SECRET` values must be identical.
Never put the service-role key in either frontend environment.

Optional backend settings:

```dotenv
OPENAI_API_KEY=
ORCHESTRATION_MODEL=gpt-5.4
MANUAL_RESOLVER_MODEL=gpt-4.1-mini
MEDIA_MEAL_RESOLVER_MODEL=gpt-4.1-mini
VISION_MODEL=gpt-4.1-mini
AUDIO_MODEL=gpt-4o-mini-transcribe

LANGSMITH_API_KEY=
LANGSMITH_WORKSPACE_ID=
LANGSMITH_PROJECT=nutrient-tracker-agents
LANGSMITH_TRACING=false
```

Without `OPENAI_API_KEY`, normal meals, goals, hydration, reports, and account
features still work. Chat, transcription, and media extraction report that AI is
disabled.

## Database Setup

Choose either a hosted Supabase project or a local Supabase stack.

### Option A: Hosted Supabase

Authenticate, link the project, and apply migrations:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

If project linking is unavailable but you have a percent-encoded Postgres URL:

```bash
npx supabase db push --db-url "$DATABASE_URL" --include-all
```

Do not place the database password or `DATABASE_URL` in the repository.

### Option B: Local Supabase

Docker must be running:

```bash
npx supabase start
npx supabase db reset
```

Use the URL and keys printed by `npx supabase status` in the three application
environment files. Local services from `supabase/config.toml` include:

| Local service | URL |
|---|---|
| Supabase API | `http://127.0.0.1:54321` |
| PostgreSQL | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| Supabase Studio | `http://127.0.0.1:54323` |

Stop the local stack with:

```bash
npx supabase stop
```

### Optional Food Seed

After migrations and backend environment configuration:

```bash
make seed
```

This loads the curated starter dish set. It is optional; rerunning it creates new
catalog versions.

## Run The Repository

Start all three applications from the repository root:

```bash
make dev
```

Open:

| Application | URL |
|---|---|
| Customer app | `http://localhost:3000` |
| Internal dashboard | `http://localhost:3001` |
| FastAPI docs | `http://localhost:8000/docs` |
| FastAPI health | `http://localhost:8000/health` |

`make dev` starts only the backend and Next.js applications. Supabase must
already be reachable.

### Run Services Separately

Use three terminals:

```bash
# Terminal 1: backend
make backend

# Terminal 2: customer app
cd customer-app
npm run dev

# Terminal 3: internal dashboard
cd internal-dashboard
npm run dev
```

Production-style local builds:

```bash
cd customer-app && npm run build && npm run start
cd internal-dashboard && npm run build && npm run start
cd backend && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Run each command in a separate terminal because both Next.js `start` commands
remain active.

## Authentication

The customer app uses Supabase Google OAuth. Configure Google in Supabase before
using sign-in:

1. Create a Google Web OAuth client.
2. Add `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback` to its authorized
   redirect URIs.
3. Enable Google under Supabase **Authentication > Providers**.
4. Add `http://localhost:3000/auth/callback` under Supabase **Authentication >
   URL Configuration > Redirect URLs**.

The first customer login creates the application user and customer role through
the database bootstrap migration, then redirects to onboarding.

### Grant Dashboard Access

Sign in once, then run this in the Supabase SQL editor:

```sql
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'admin'::public.app_role
FROM public.app_users
WHERE email = 'you@example.com'
ON CONFLICT (user_id, role) DO NOTHING;
```

The dashboard verifies this database role; Supabase user metadata is not trusted
for authorization.

## AI And Prompt Setup

Nutrition Chat receives all six tools on every turn and chooses tools using their
descriptions, schemas, current tracker context, and conversation history. Explicit
text/voice writes execute atomically. Image and PDF meal drafts remain editable
and require their dedicated Confirm or Discard button.

When LangSmith is configured, publish checked-in prompts with:

```bash
cd backend
PYTHONPATH=. uv run python scripts/publish_prompts.py
```

Reusable destructive live-agent verification creates an isolated Supabase user,
checks real database writes, and deletes the user afterward:

```bash
cd backend
PYTHONPATH=. uv run python scripts/live_nutrition_chat_matrix.py --dosa-only
PYTHONPATH=. uv run python scripts/live_nutrition_chat_matrix.py --breakfast-only
```

These commands require real Supabase service-role and OpenAI credentials. Never
run them against a user account whose data must be preserved.

## Common Commands

Run from the repository root unless shown otherwise:

| Command | Purpose |
|---|---|
| `make setup` | Install Python, frontend, and root dependencies |
| `make dev` | Start backend, customer app, and dashboard |
| `make backend` | Start only FastAPI with reload |
| `make migrate` | Push migrations for a linked Supabase project |
| `make seed` | Load optional curated dishes |
| `make lint` | Ruff lint and format check |
| `make typecheck` | Backend boundary checks and frontend TypeScript checks |
| `make check` | Full repository check target |
| `make e2e-install` | Install Playwright Chromium |
| `make e2e-list` | List hosted Playwright scenarios |
| `make e2e-check` | Compile and statically validate E2E tooling |

Application-specific commands:

```bash
cd backend && uv sync
cd customer-app && npm install
cd internal-dashboard && npm install

cd customer-app && npm run build
cd internal-dashboard && npm run build
```

## Troubleshooting

### Backend cannot reach Supabase

Check `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `backend/.env`, then verify:

```bash
curl http://localhost:8000/health
```

### Frontend reports backend auth configuration errors

Confirm that `BACKEND_JWT_SECRET` exists in the app's `.env.local` and exactly
matches `JWT_SECRET_KEY` in `backend/.env`. Restart both services after changing
environment files.

### A hosted schema is behind

Inspect migration state and push pending files:

```bash
npx supabase migration list --linked
npx supabase db push
```

### Next.js uses stale route types after deleting a route

Run a production build before typecheck:

```bash
cd customer-app
npm run build
npm run typecheck
```

## Security Notes

- Never commit `.env`, `.env.local`, database passwords, service-role keys, or
  OpenAI credentials.
- Rotate any credential pasted into chat, logs, screenshots, or terminal output.
- Keep `SUPABASE_SERVICE_ROLE_KEY` backend-only.
- The backend uses the service-role client, so repository user scoping and RBAC
  are the primary application authorization boundaries; RLS remains defense in
  depth for other database access paths.
- This application is a nutrition tracking tool, not medical advice.
