"""Load the repository ``.env`` without overriding the process."""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv


def repository_root() -> Path | None:
    """Return the Chatticus repository root that holds ``.env``, if present."""
    for parent in Path(__file__).resolve().parents:
        if (parent / ".env.example").is_file():
            return parent
    return None


def load_local_env() -> None:
    """Load ``.env`` from the repository root without overriding the process."""
    root = repository_root()
    if root is None:
        return
    load_dotenv(root / ".env", override=False)
