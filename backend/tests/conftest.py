"""Test fixtures.

Env is stubbed at import so Settings() constructs without a real project.
"""

from __future__ import annotations

import os
import sys
import types

import pytest

os.environ.setdefault("SUPABASE_URL", "http://127.0.0.1:54321")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
os.environ.setdefault("JWT_SECRET_KEY", "test-jwt-secret-at-least-32-bytes")
os.environ.setdefault("ENVIRONMENT", "test")


def _stub_supabase() -> None:
    """The supabase package is not needed for unit tests."""
    if "supabase" in sys.modules:
        return
    m = types.ModuleType("supabase")
    m.AsyncClient = object

    async def _acreate(*a, **k):
        raise RuntimeError("stubbed")

    m.acreate_client = _acreate
    sys.modules["supabase"] = m

    lib = types.ModuleType("supabase.lib")
    sys.modules["supabase.lib"] = lib
    opts = types.ModuleType("supabase.lib.client_options")

    class AsyncClientOptions:
        def __init__(self, **k) -> None:
            self.__dict__.update(k)

    opts.AsyncClientOptions = AsyncClientOptions
    sys.modules["supabase.lib.client_options"] = opts


_stub_supabase()


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    """CI treats skipped coverage as missing coverage, not a successful run."""
    if os.environ.get("NT_FAIL_ON_SKIP") != "1":
        return
    reporter = session.config.pluginmanager.get_plugin("terminalreporter")
    if reporter is not None and reporter.stats.get("skipped"):
        reporter.write_sep("=", "skipped tests are forbidden in CI")
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
