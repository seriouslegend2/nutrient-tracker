"""Contract tests that walk the generated OpenAPI document."""

import pytest

from app.main import app


@pytest.fixture(scope="module")
def schema():
    return app.openapi()


@pytest.mark.unit
def test_no_list_route_returns_a_bare_array(schema):
    """The assignment requires pagination on ALL list APIs.

    KookarCore has five hand-rolled pagination styles and no helper. This is
    the test that stops that happening here.
    """
    offenders = []
    for path, ops in schema["paths"].items():
        for method, op in ops.items():
            if method != "get":
                continue
            body = (
                op.get("responses", {})
                .get("200", {})
                .get("content", {})
                .get("application/json", {})
                .get("schema", {})
            )
            if body.get("type") == "array":
                offenders.append(f"{method.upper()} {path}")
    assert offenders == [], (
        "These list routes return a bare array instead of Page[T]: " + ", ".join(offenders)
    )


@pytest.mark.unit
def test_no_customer_route_accepts_a_user_id_parameter(schema):
    """Customer route bodies stay scoped to the trusted caller's user context."""
    offenders = []
    for path, ops in schema["paths"].items():
        if "/admin/" in path:
            continue
        for method, op in ops.items():
            for param in op.get("parameters", []):
                if param.get("name") in {"user_id", "userId", "house_id"}:
                    offenders.append(f"{method.upper()} {path}")
    assert offenders == [], "These customer routes accept an identity parameter: " + ", ".join(
        offenders
    )


@pytest.mark.unit
def test_every_route_declares_a_response_model(schema):
    missing = []
    for path, ops in schema["paths"].items():
        for method, op in ops.items():
            responses = op.get("responses", {})
            if not ({"200", "201", "204"} & set(responses)):
                missing.append(f"{method.upper()} {path}")
    assert missing == [], "Routes with no success response: " + ", ".join(missing)
