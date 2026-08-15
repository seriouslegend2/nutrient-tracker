#!/usr/bin/env bash
# Frontends may use Supabase for server-side auth only. Application data flows
# through same-origin route handlers, which are the only callers of FastAPI.
set -euo pipefail

fail=0
extensions=(--include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx')

report_matches() {
  local message=$1
  local matches=$2
  if [[ -n "$matches" ]]; then
    printf 'FAIL: %s\n%s\n' "$message" "$matches"
    fail=1
  fi
}

for app in customer-app internal-dashboard; do
  [[ -d "$app" ]] || continue
  roots=("$app/app" "$app/src")
  scan_paths=("${roots[@]}" "$app/proxy.ts")

  # Auth helpers are the only source files allowed to import Supabase packages.
  matches=$(
    grep -rln "@supabase/" "${scan_paths[@]}" "${extensions[@]}" 2>/dev/null \
      | grep -vE "^${app}/src/lib/supabase/server\.ts$|^${app}/proxy\.ts$" || true
  )
  report_matches "$app imports Supabase outside server-side auth helpers" "$matches"

  # Catch table/RPC access without flagging unrelated Array.from calls.
  matches=$(grep -rnE '\bsupabase[A-Za-z0-9_]*\s*\.\s*(from|rpc)\s*\(' \
    "${scan_paths[@]}" "${extensions[@]}" 2>/dev/null || true)
  report_matches "$app queries Supabase application data directly" "$matches"

  # These names and drivers are database/server credentials, never frontend config.
  matches=$(grep -rnE \
    'SUPABASE_(SERVICE_ROLE|SECRET)_KEY|DATABASE_URL|POSTGRES_(URL|PASSWORD)|\b(PGHOST|PGPASSWORD)\b|postgres(ql)?://' \
    "${scan_paths[@]}" "${extensions[@]}" 2>/dev/null || true)
  report_matches "$app source contains a backend database marker" "$matches"

  matches=$(grep -rnE \
    "from[[:space:]]+['\"](pg|postgres|mysql2?|better-sqlite3|@prisma/client|@neondatabase/serverless|drizzle-orm)['\"]" \
    "${scan_paths[@]}" "${extensions[@]}" 2>/dev/null || true)
  report_matches "$app source imports a database driver" "$matches"

  matches=$(grep -rnE \
    'NEXT_PUBLIC_[A-Z0-9_]*(BACKEND|SERVICE_ROLE|SECRET|DATABASE|POSTGRES)|NEXT_PUBLIC_API_URL' \
    "${scan_paths[@]}" "${extensions[@]}" 2>/dev/null || true)
  report_matches "$app exposes backend configuration to the browser bundle" "$matches"

  # The server-only API config is the single location that may know FastAPI's URL.
  matches=$(
    grep -rlnE 'BACKEND_API_URL|https?://(localhost|127\.0\.0\.1):8000' \
      "${scan_paths[@]}" "${extensions[@]}" 2>/dev/null \
      | grep -vE "^${app}/src/lib/config/api\.ts$" || true
  )
  report_matches "$app references FastAPI outside its server-only API config" "$matches"

  # Even an imported server helper is unsafe if a client module pulls it into a bundle.
  while IFS= read -r client_file; do
    [[ -n "$client_file" ]] || continue
    matches=$(grep -nE \
      'BACKEND_API_URL|SUPABASE_(SERVICE_ROLE|SECRET)_KEY|DATABASE_URL|postgres(ql)?://|https?://(localhost|127\.0\.0\.1):8000' \
      "$client_file" 2>/dev/null || true)
    report_matches "$client_file contains server-only backend configuration" "$matches"
  done < <(grep -rlE "^[[:space:]]*['\"]use client['\"]" "${roots[@]}" "${extensions[@]}" 2>/dev/null || true)
done

if [[ "$fail" -eq 0 ]]; then
  echo "OK: frontend source is isolated from database and direct backend access"
fi
exit "$fail"
