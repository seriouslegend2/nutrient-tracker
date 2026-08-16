"""Runtime identity context shared by tool-enabled agents."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class NutrientTrackerRuntimeContext:
    user_id: str
    thread_id: str | None = None
    timezone: str = "UTC"
