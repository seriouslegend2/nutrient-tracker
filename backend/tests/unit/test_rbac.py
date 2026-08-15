"""RBAC. The bug KookarCore shipped is the thing being tested here."""

import inspect

import pytest

from app.core.deps import Permission, Role, require_permission


@pytest.mark.unit
def test_require_permission_is_a_sync_factory():
    """KookarCore's require_role is an `async def` factory, so
    Depends(require_role("admin")) injects an un-awaited coroutine and the
    check silently never runs. This asserts we did not repeat that.
    """
    assert not inspect.iscoroutinefunction(require_permission)
    dep = require_permission(Permission.READ_ANY_USER)
    assert inspect.iscoroutinefunction(dep)


@pytest.mark.unit
def test_customer_cannot_read_other_users():
    from app.core.deps import ROLE_PERMISSIONS

    customer = ROLE_PERMISSIONS[Role.CUSTOMER]
    assert Permission.READ_OWN_DATA in customer
    assert Permission.READ_ANY_USER not in customer
    assert Permission.MANAGE_USERS not in customer


@pytest.mark.unit
def test_admin_has_every_permission():
    from app.core.deps import ROLE_PERMISSIONS

    assert ROLE_PERMISSIONS[Role.ADMIN] == frozenset(Permission)
