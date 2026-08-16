from __future__ import annotations

from types import SimpleNamespace

from app.services import prompts


async def test_prompt_resolution_falls_back_without_langsmith(monkeypatch) -> None:
    prompts.clear_prompt_cache()
    monkeypatch.setattr(prompts.settings, "LANGSMITH_API_KEY", "")

    resolved = await prompts.resolve_prompt("test-prompt", "checked-in fallback")

    assert resolved.text == "checked-in fallback"
    assert resolved.source == "code"
    assert resolved.version is None


async def test_prompt_resolution_extracts_template_and_commit(monkeypatch) -> None:
    prompts.clear_prompt_cache()

    class FakeClient:
        def pull_prompt(self, name: str, *, include_model: bool) -> SimpleNamespace:
            assert name == "test-prompt"
            assert include_model is False
            return SimpleNamespace(
                template="remote {{prompt}}",
                metadata={
                    "lc_hub_commit_hash": "commit-123",
                    "nutrient_tracker_literal_braces": True,
                },
            )

    monkeypatch.setattr(prompts, "langsmith_client", lambda: FakeClient())

    resolved = await prompts.resolve_prompt("test-prompt", "fallback")

    assert resolved.text == "remote {prompt}"
    assert resolved.source == "langsmith"
    assert resolved.version == "commit-123"
