"""Authentication for trusted callers of the FastAPI service."""

from __future__ import annotations

from typing import Any

import jwt
from pydantic import BaseModel, Field

from app.config.settings import settings
from app.core.exceptions import UnauthorizedError


class ServiceTokenData(BaseModel):
    """Identity encoded in the permanent backend bearer JWT."""

    user_id: str
    house_id: int = 0
    roles: list[str] = Field(default_factory=list)


def verify_service_token(token: str) -> ServiceTokenData:
    """Verify a permanent backend JWT and return its user identity."""
    if settings.DISABLE_AUTH_FOR_LOCAL and not settings.is_production():
        return ServiceTokenData(user_id="00000000-0000-0000-0000-000000000000", roles=["admin"])
    if not settings.JWT_SECRET_KEY:
        raise UnauthorizedError("Service authentication is not configured", code="AUTH_CONFIG")
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
        )
    except jwt.ExpiredSignatureError as exc:
        raise UnauthorizedError("Token has expired", code="TOKEN_EXPIRED") from exc
    except jwt.InvalidTokenError as exc:
        raise UnauthorizedError("Invalid service token", code="BAD_SERVICE_TOKEN") from exc

    user_id = payload.get("user_id")
    if not isinstance(user_id, str) or not user_id:
        raise UnauthorizedError("Invalid service token payload", code="BAD_SERVICE_TOKEN")
    house_id = payload.get("house_id") or 0
    roles = payload.get("roles") or []
    if (
        not isinstance(house_id, int)
        or not isinstance(roles, list)
        or not all(isinstance(role, str) for role in roles)
    ):
        raise UnauthorizedError("Invalid service token payload", code="BAD_SERVICE_TOKEN")
    return ServiceTokenData(
        user_id=user_id,
        house_id=house_id,
        roles=roles,
    )
