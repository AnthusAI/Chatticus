"""One host start for one household computer.

Concurrent turns and retries must not create split-brain workplaces.
A start claim is keyed by tenant and computer identity. Only one live
host may write the disk.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class HostStartClaim:
    """Conditional start for one computer."""

    tenant_id: str
    computer_id: str
    host_start_count: int
    waiting_turn_ids: list[str] = field(default_factory=list)
    live_writer_host_id: str | None = None
    expires_at: datetime | None = None
