"""Loguru, configured once.

RULE, inherited from KookarCore and stated there as a hard one: messages are
PARAMETERISED, never f-strings - `logger.info("x={} y={}", a, b)`. f-strings
defeat structured logging and are evaluated even when the level is off.
Use `logger.exception()` on failure so the traceback is attached.
"""

from __future__ import annotations

import sys

from loguru import logger

from app.config.settings import settings

logger.remove()
logger.add(
    sys.stdout,
    level=settings.LOG_LEVEL,
    backtrace=False,  # tracebacks come from logger.exception(), not every line
    diagnose=settings.DEBUG,  # variable values in tracebacks: dev only, they leak
    format=(
        "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | "
        "<level>{level: <8}</level> | "
        "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - "
        "<level>{message}</level>"
    ),
)

__all__ = ["logger"]
