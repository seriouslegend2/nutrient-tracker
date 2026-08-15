"""Generate a permanent user-specific backend JWT (no exp claim)."""

from __future__ import annotations

import argparse
import os
from uuid import UUID

import jwt


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--user-id", required=True, help="Supabase auth user UUID")
    args = parser.parse_args()
    try:
        user_id = str(UUID(args.user_id))
    except ValueError as exc:
        raise SystemExit("--user-id must be a UUID") from exc
    secret = os.environ.get("JWT_SECRET_KEY", "").strip()
    if not secret:
        raise SystemExit("JWT_SECRET_KEY must be set")
    if len(secret.encode()) < 32:
        raise SystemExit("JWT_SECRET_KEY must be at least 32 bytes")
    print(
        jwt.encode(
            {"user_id": user_id, "house_id": 0, "roles": ["user"]},
            secret,
            algorithm="HS256",
        )
    )


if __name__ == "__main__":
    main()
