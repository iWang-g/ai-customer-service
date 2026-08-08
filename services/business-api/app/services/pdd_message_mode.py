from __future__ import annotations

from typing import Literal

from app.core.config import Settings


PddMessageWriteMode = Literal["snapshot", "disabled"]


def pdd_message_write_mode(
    settings: Settings,
) -> PddMessageWriteMode:
    """Resolve one mutually exclusive Pinduoduo message writer platform-wide."""
    if settings.pdd_message_snapshot_write_enabled:
        return "snapshot"
    return "disabled"
