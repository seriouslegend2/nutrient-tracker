"""Dependencies: current user and working RBAC.

KookarCore's ``require_role`` has ZERO call sites and is broken - it is an
``async def`` factory, so ``Depends(require_role("admin"))`` injects a
coroutine object rather than running the check. This is the fixed version:
a SYNC factory returning an async dependency.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from enum import StrEnum
from uuid import UUID

from fastapi import Depends, Header, Request
from pydantic import BaseModel, Field

from app.core.exceptions import PermissionDeniedError, UnauthorizedError
from app.core.security import verify_service_token
from app.services.identity import load_identity


class Role(StrEnum):
    CUSTOMER = "customer"
    ADMIN = "admin"


class Permission(StrEnum):
    READ_OWN_DATA = "read:own_data"
    WRITE_OWN_DATA = "write:own_data"
    READ_ANY_USER = "read:any_user"
    MANAGE_USERS = "manage:users"
    VIEW_SYSTEM_OPS = "view:system_ops"


ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.CUSTOMER: frozenset({Permission.READ_OWN_DATA, Permission.WRITE_OWN_DATA}),
    Role.ADMIN: frozenset(Permission),
}


class CurrentUser(BaseModel):
    """User identity decoded from the verified backend JWT."""

    id: str
    email: str | None = None
    roles: list[Role] = Field(default_factory=list)
    access_token: str

    @property
    def permissions(self) -> frozenset[Permission]:
        out: set[Permission] = set()
        for role in self.roles:
            out |= ROLE_PERMISSIONS.get(role, frozenset())
        return frozenset(out)

    @property
    def is_admin(self) -> bool:
        return Role.ADMIN in self.roles


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise UnauthorizedError(
            "Missing or invalid authorization header",
            code="NO_AUTH_HEADER",
            suggested_action="Provide a valid backend bearer token.",
        )
    return authorization.split(" ", 1)[1].strip()


async def get_current_user(
    request: Request,
    authorization: str | None = Header(None),
) -> CurrentUser:
    """Verify the bearer and load roles for the user encoded in its payload."""
    bearer = _bearer(authorization)
    token = verify_service_token(bearer)
    try:
        user_id = str(UUID(token.user_id))
    except ValueError as exc:
        raise UnauthorizedError("Invalid token user", code="BAD_SERVICE_TOKEN") from exc

    identity = await load_identity(user_id)
    roles: list[Role] = []
    for role in identity.roles:
        try:
            roles.append(Role(role))
        except ValueError:
            continue
    request.state.user_id = user_id
    return CurrentUser(
        id=user_id,
        email=identity.email,
        roles=roles or [Role.CUSTOMER],
        access_token=bearer,
    )


def require_permission(permission: Permission) -> Callable[..., Awaitable[CurrentUser]]:
    """SYNC factory returning an async dependency.

    The sync/async distinction is the entire bug KookarCore shipped: an async
    factory makes ``Depends(...)`` inject an un-awaited coroutine, so the check
    silently never runs.
    """

    async def _check(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if permission not in user.permissions:
            raise PermissionDeniedError(
                f"Permission '{permission.value}' is required",
                code="PERMISSION_DENIED",
                suggested_action="This action is restricted to administrators.",
            )
        return user

    return _check
