from __future__ import annotations

from types import SimpleNamespace

import jwt
import pytest

from app.config.settings import settings
from app.core import deps
from app.core.exceptions import UnauthorizedError

USER_ID = "8b12ed0b-6c96-4529-8f2a-d0a235b46a5e"


def _token() -> str:
    return jwt.encode(
        {"user_id": USER_ID, "house_id": 0, "roles": ["user"]},
        settings.JWT_SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )


async def test_backend_bearer_supplies_user_identity(monkeypatch) -> None:
    calls: list[tuple[str, str | None]] = []

    async def load_identity(user_id: str):
        calls.append((user_id, None))
        return SimpleNamespace(email="person@example.com", roles=["admin"])

    monkeypatch.setattr(deps, "load_identity", load_identity)
    request = SimpleNamespace(state=SimpleNamespace())

    user = await deps.get_current_user(
        request,
        authorization=f"Bearer {_token()}",
    )

    assert user.id == USER_ID
    assert user.roles == [deps.Role.ADMIN]
    assert user.email == "person@example.com"
    assert request.state.user_id == USER_ID
    assert calls == [(USER_ID, None)]


async def test_bad_backend_bearer_is_rejected() -> None:
    request = SimpleNamespace(state=SimpleNamespace())
    with pytest.raises(UnauthorizedError) as error:
        await deps.get_current_user(
            request,
            authorization="Bearer wrong-token",
        )
    assert error.value.code == "BAD_SERVICE_TOKEN"


async def test_invalid_token_user_is_rejected() -> None:
    request = SimpleNamespace(state=SimpleNamespace())
    token = jwt.encode(
        {"user_id": "not-a-uuid", "roles": ["user"]},
        settings.JWT_SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )
    with pytest.raises(UnauthorizedError) as error:
        await deps.get_current_user(
            request,
            authorization=f"Bearer {token}",
        )
    assert error.value.code == "BAD_SERVICE_TOKEN"
