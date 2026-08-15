"""Domain exceptions.

KookarCore has a well-designed exception class carrying ``code`` and
``suggested_action`` that is *stranded* - nothing ever converts it to a
response, so those fields never reach a client. We take the class design and
add the wiring (see ``error_handlers.py``).
"""

from __future__ import annotations

from typing import Any


class AppError(Exception):
    """Base for every domain error. Carries everything the client needs."""

    status_code: int = 400

    def __init__(
        self,
        message: str,
        *,
        code: str,
        suggested_action: str | None = None,
        context: dict[str, Any] | None = None,
    ) -> None:
        self.message = message
        self.code = code
        self.suggested_action = suggested_action
        self.context = context or {}
        super().__init__(message)


class NotFoundError(AppError):
    status_code = 404


class ValidationError(AppError):
    status_code = 422


class PermissionDeniedError(AppError):
    status_code = 403


class UnauthorizedError(AppError):
    status_code = 401


class ConflictError(AppError):
    status_code = 409


class UpstreamError(AppError):
    status_code = 502


# ---------------------------------------------------------------------------
# Domain-specific errors. Each one is self-documenting: the message, the code
# and the suggested action are all decided here, not at the raise site.
# ---------------------------------------------------------------------------


class UnsafeGoalError(ValidationError):
    """The safety ladder refused or clamped a target. See PLAN §05."""

    def __init__(self, requested_kcal: float, floor_kcal: float) -> None:
        super().__init__(
            f"Target intake {requested_kcal:.0f} kcal/day is below the safe floor "
            f"of {floor_kcal:.0f} kcal/day.",
            code="UNSAFE_CALORIE_TARGET",
            suggested_action="Extend the target date or reduce the weight-change goal.",
            context={"requested_kcal": requested_kcal, "floor_kcal": floor_kcal},
        )


class VLCDRefusedError(ValidationError):
    """Below 800 kcal/day requires medical supervision. Refused, not clamped."""

    def __init__(self, requested_kcal: float) -> None:
        super().__init__(
            f"A target of {requested_kcal:.0f} kcal/day is a very-low-calorie diet, "
            "which requires medical supervision.",
            code="VLCD_REFUSED",
            suggested_action=(
                "Please speak to a doctor or dietitian before setting a goal this "
                "aggressive. We can set a safe target instead."
            ),
            context={"requested_kcal": requested_kcal},
        )


class IncompleteProfileError(ValidationError):
    def __init__(self, missing: list[str]) -> None:
        super().__init__(
            f"Profile is missing: {', '.join(missing)}.",
            code="INCOMPLETE_PROFILE",
            suggested_action="Complete your profile before setting this goal.",
            context={"missing": missing},
        )


class UnresolvedDishError(ValidationError):
    """We could not establish a portion. Ask - never guess silently."""

    def __init__(self, dish_name: str) -> None:
        super().__init__(
            f"Could not work out a portion size for '{dish_name}'.",
            code="UNRESOLVED_PORTION",
            suggested_action="Tell us how much you had, in grams or in katoris.",
            context={"dish_name": dish_name},
        )
