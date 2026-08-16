"""Application service for proposing and executing durable agent actions."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from uuid import UUID

from pydantic import TypeAdapter

from app.core.exceptions import AppError, ConflictError, ValidationError
from app.domain.agent_actions.models import (
    AgentAction,
    AgentActionCreate,
    AgentActionStatus,
    JsonObject,
)
from app.domain.agent_actions.repository import AgentActionRepository
from app.domain.agent_actions.repository import repository as default_repository
from app.utils.logger import logger

ActionExecutor = Callable[[AgentAction], Awaitable[JsonObject | None]]
AtomicActionExecutor = Callable[[AgentAction, UUID], Awaitable[AgentAction]]
_JSON_OBJECT = TypeAdapter(JsonObject)


class ActionDispatcher:
    """Exact action-type registry: no wildcard or dynamic import fallback."""

    def __init__(self) -> None:
        self._executors: dict[str, ActionExecutor] = {}
        self._atomic_executors: dict[str, AtomicActionExecutor] = {}

    def register(self, action_type: str, executor: ActionExecutor) -> None:
        validated = AgentActionCreate.model_validate(
            {
                "action_type": action_type,
                "arguments": {},
                "summary": "Registry validation",
                "idempotency_key": "registry-validation",
                "expires_at": datetime.max.replace(tzinfo=UTC),
            }
        ).action_type
        if validated in self._executors or validated in self._atomic_executors:
            raise ValueError(f"Executor already registered for {validated!r}")
        self._executors[validated] = executor

    def register_atomic(self, action_type: str, executor: AtomicActionExecutor) -> None:
        validated = AgentActionCreate.model_validate(
            {
                "action_type": action_type,
                "arguments": {},
                "summary": "Registry validation",
                "idempotency_key": "registry-validation",
                "expires_at": datetime.max.replace(tzinfo=UTC),
            }
        ).action_type
        if validated in self._executors or validated in self._atomic_executors:
            raise ValueError(f"Executor already registered for {validated!r}")
        self._atomic_executors[validated] = executor

    def resolve(self, action_type: str) -> ActionExecutor:
        try:
            return self._executors[action_type]
        except KeyError as exc:
            raise ValidationError(
                f"No executor is registered for action type '{action_type}'.",
                code="AGENT_ACTION_UNSUPPORTED",
            ) from exc

    def resolve_atomic(self, action_type: str) -> AtomicActionExecutor | None:
        return self._atomic_executors.get(action_type)


default_dispatcher = ActionDispatcher()


async def create_action(
    *,
    user_id: str,
    action_type: str,
    arguments: JsonObject,
    summary: str,
    idempotency_key: str,
    expires_at: datetime,
    repository: AgentActionRepository = default_repository,
) -> AgentAction:
    proposal = AgentActionCreate(
        action_type=action_type,
        arguments=arguments,
        summary=summary,
        idempotency_key=idempotency_key,
        expires_at=expires_at,
    )
    now = datetime.now(UTC)
    if proposal.expires_at.utcoffset() is None:
        raise ValidationError(
            "Agent action expiry must include a timezone.", code="AGENT_ACTION_INVALID_EXPIRY"
        )
    if proposal.expires_at <= now:
        raise ValidationError(
            "Agent action expiry must be in the future.", code="AGENT_ACTION_INVALID_EXPIRY"
        )
    row = await repository.create(user_id=user_id, **proposal.model_dump())
    return AgentAction.model_validate(row)


async def get(
    *,
    user_id: str,
    action_id: UUID,
    repository: AgentActionRepository = default_repository,
) -> AgentAction:
    return AgentAction.model_validate(await repository.get(user_id=user_id, action_id=action_id))


async def confirm_and_execute(
    *,
    user_id: str,
    action_id: UUID,
    executor: ActionExecutor | None = None,
    atomic_executor: AtomicActionExecutor | None = None,
    dispatcher: ActionDispatcher = default_dispatcher,
    repository: AgentActionRepository = default_repository,
    lease_seconds: int = 60,
) -> AgentAction:
    """Confirm, exclusively claim, execute, and durably record one action.

    The Python callback and completion RPC are separate transactions. Executors
    must therefore use ``action.id`` as their domain idempotency key. A supplied
    ``atomic_executor`` instead receives the fencing token and must return the
    action completed by one domain-specific SQL transaction.
    """
    current = await get(user_id=user_id, action_id=action_id, repository=repository)
    if current.status in {AgentActionStatus.COMPLETED, AgentActionStatus.FAILED}:
        return current
    if current.status in {AgentActionStatus.EXPIRED, AgentActionStatus.DISCARDED}:
        raise ConflictError(
            f"Agent action is {current.status.value} and cannot be confirmed.",
            code="AGENT_ACTION_NOT_CONFIRMABLE",
        )

    if executor is not None and atomic_executor is not None:
        raise ValidationError(
            "Choose either a Python executor or an atomic executor, not both.",
            code="AGENT_ACTION_EXECUTOR_CONFLICT",
        )
    selected_executor = None
    if atomic_executor is None and executor is None:
        atomic_executor = dispatcher.resolve_atomic(current.action_type)
    if atomic_executor is None:
        selected_executor = executor or dispatcher.resolve(current.action_type)
    confirmed = AgentAction.model_validate(
        await repository.confirm(user_id=user_id, action_id=action_id)
    )
    if confirmed.status == AgentActionStatus.EXPIRED:
        raise ConflictError(
            "Agent action expired before confirmation.", code="AGENT_ACTION_EXPIRED"
        )
    if confirmed.status in {AgentActionStatus.DISCARDED, AgentActionStatus.FAILED}:
        return confirmed

    claim = await repository.claim(
        user_id=user_id, action_id=action_id, lease_seconds=lease_seconds
    )
    if not claim.claimed:
        return claim.action
    if claim.claim_token is None:
        raise RuntimeError("Claimed agent action did not return a fencing token")

    try:
        if atomic_executor is not None:
            completed_action = await atomic_executor(claim.action, claim.claim_token)
            if (
                completed_action.id != claim.action.id
                or completed_action.user_id != claim.action.user_id
                or completed_action.status != AgentActionStatus.COMPLETED
            ):
                raise RuntimeError("Atomic executor did not return the completed claimed action")
            return completed_action
        if selected_executor is None:
            raise RuntimeError("Agent action has no executor")
        result = _JSON_OBJECT.validate_python(await selected_executor(claim.action) or {})
    except Exception as exc:
        if atomic_executor is not None:
            try:
                latest = await get(user_id=user_id, action_id=action_id, repository=repository)
                if latest.status == AgentActionStatus.COMPLETED:
                    return latest
            except Exception:
                pass
        if isinstance(exc, AppError):
            error: JsonObject = {"code": exc.code, "message": exc.message}
        else:
            logger.exception(
                "agent_action_execution_failed action_id={} action_type={}",
                action_id,
                claim.action.action_type,
            )
            error = {
                "code": "EXECUTION_FAILED",
                "message": "The operation could not be completed.",
            }
        try:
            failed = await repository.fail(
                user_id=user_id,
                action_id=action_id,
                claim_token=claim.claim_token,
                error=error,
            )
            return AgentAction.model_validate(failed)
        except ConflictError:
            latest = await get(user_id=user_id, action_id=action_id, repository=repository)
            if latest.status in {AgentActionStatus.COMPLETED, AgentActionStatus.FAILED}:
                return latest
            raise

    completed = await repository.complete(
        user_id=user_id,
        action_id=action_id,
        claim_token=claim.claim_token,
        result=result,
    )
    return AgentAction.model_validate(completed)


async def discard(
    *,
    user_id: str,
    action_id: UUID,
    repository: AgentActionRepository = default_repository,
) -> AgentAction:
    action = AgentAction.model_validate(
        await repository.discard(user_id=user_id, action_id=action_id)
    )
    if action.status != AgentActionStatus.DISCARDED:
        raise ConflictError(
            f"Agent action is {action.status.value} and cannot be discarded.",
            code="AGENT_ACTION_NOT_DISCARDABLE",
        )
    return action
