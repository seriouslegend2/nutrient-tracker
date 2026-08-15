# Runtime And Build DAG

This graph describes the checked-in implementation. An edge `A -> B` means B
depends on A at build or runtime.

```text
supabase/config.toml
  -> supabase/migrations/*.sql (12 ordered migrations)
       -> Postgres tables, functions, triggers, indexes, grants, RLS
       -> backend/app/services/supabase.py

backend/app/config/settings.py
  -> backend/app/services/supabase.py (server-side service-role client)
  -> backend/app/core/security.py (HS256 backend bearer verification)

backend/app/core/{security,deps,pagination,error_handlers}.py
  -> backend/app/domain/**
  -> backend/app/api/v1/**
  -> backend/app/router_registry/__init__.py
  -> backend/app/main.py

backend/app/services/media_extraction.py
  -> backend/app/agents/media_extraction/{agent,runner,state}.py
  -> backend/app/api/v1/messages_router.py

backend/app/domain/{dishes,meals,goals,profile,reports,water,messages}/**
  -> backend/app/agents/nutrition_chat/{agent,runner,tools,middleware,models,prompt,render,state}.py
  -> backend/app/api/v1/messages_router.py

customer email/password signup or login
  -> customer-app/app/api/auth/{signup,login}/route.ts
  -> customer-app/src/lib/supabase/server.ts
  -> optional customer email-confirmation code exchange at /auth/callback
  -> Supabase Auth session in secure httpOnly cookies
  -> customer-app/app/api/**/route.ts
  -> user-specific HS256 backend bearer
  -> FastAPI /api/v1/**
  -> first-run onboarding gate

existing account email/password dashboard sign-in
  -> internal-dashboard/app/api/auth/login/route.ts
  -> internal-dashboard/src/lib/supabase/server.ts
  -> Supabase Auth session in secure httpOnly cookies (no dashboard callback)
  -> internal-dashboard/app/api/**/route.ts
  -> user-specific HS256 backend bearer
  -> backend user_roles admin check
  -> FastAPI /api/v1/admin/**

customer or dashboard logout
  -> server-side Supabase signOut
  -> local session cleared
```

## Migration Order

```text
20260815100000  extensions and enums
20260815100100  users and profiles
20260815100200  dishes and portions
20260815100300  meals
20260815100400  goals and logs
20260815100500  body-metric functions
20260815100600  resolver functions
20260815100700  lookup chain and triggers
20260815100800  RLS policies
20260815100900  18 global category defaults
20260816100000  auth-user bootstrap
20260816110000  backend/database remediation and atomic RPCs
```

## Independent Build Branches

- `backend/` installs from `pyproject.toml` and `uv.lock`.
- `customer-app/` and `internal-dashboard/` install independently from their
  own package manifests and lockfiles.
- Both frontends use handwritten local response types. There is no generated
  shared API-type package in the current graph.
- `seeds/seed_dishes.py` is optional after migration and contains 61 curated
  dish rows. Category defaults come from migration 10 in the order above.
  There is no demo-user seed.
- The only implemented agents are `nutrition_chat` and `media_extraction`.
- The customer application owns account signup and optional email confirmation.
  The dashboard is sign-in-only; access requires an operator-granted `admin`
  row in `user_roles` after the account has signed in once.
- A supplied service-role key was exposed and must be rotated. Actual local
  environment files have public project values and placeholders for rotated
  service-role/JWT secrets; checked-in examples remain generic.

## Verification Dependencies

```text
pgvector/pgvector:pg17 container
  -> tests/integration/test_database.py
  -> empty database bootstrap
  -> all 12 migrations
  -> formula, safety, versioning, grant, and schema tests

backend source -> Ruff -> configured mypy scope -> import-linter -> pytest
frontend source -> TypeScript -> Next production build
both frontends  -> scripts/check-frontend-isolation.sh
```

CI starts the Postgres container and sets `NT_REQUIRE_DATABASE=1` and
`NT_FAIL_ON_SKIP=1`, so unavailable or skipped database tests fail the job.
The local 2026-08-16 verification reported 68 backend tests, 27 customer auth
tests, 22 dashboard tests, and zero production vulnerabilities in both frontend
audits. Both frontend lockfiles resolve Next.js 16.3.1.
