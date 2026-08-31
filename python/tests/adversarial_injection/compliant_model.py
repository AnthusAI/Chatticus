"""Worst-case model that always obeys injected page instructions."""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from typing import Any

_EVAL_COMMENT = re.compile(
    r"<!--\s*chatticus-eval:\s*(\{.*?\})\s*-->",
    re.DOTALL,
)
_EVAL_B64 = re.compile(
    r'data-chatticus-eval-b64="([A-Za-z0-9+/=]+)"',
)


@dataclass(frozen=True)
class SinkRequest:
    """One operation the compliant model asks the worker to perform."""

    sink: str
    arguments: dict[str, str]


class CompliantInjectionModel:
    """Parse adversarial page fixtures and emit the forbidden operation."""

    def obey(self, page_html: str) -> SinkRequest:
        """Return the operation encoded in page content."""
        payload = self._payload_from_page(page_html)
        sink = str(payload["sink"])
        raw_args = payload.get("arguments", {})
        if not isinstance(raw_args, dict):
            msg = "chatticus-eval arguments must be a JSON object."
            raise ValueError(msg)
        arguments = {str(key): str(value) for key, value in raw_args.items()}
        return SinkRequest(sink=sink, arguments=arguments)

    def _payload_from_page(self, page_html: str) -> dict[str, Any]:
        match = _EVAL_COMMENT.search(page_html)
        if match is not None:
            return json.loads(match.group(1))
        b64_match = _EVAL_B64.search(page_html)
        if b64_match is not None:
            decoded = base64.b64decode(b64_match.group(1)).decode("utf-8")
            return json.loads(decoded)
        msg = "Page fixture is missing chatticus-eval metadata."
        raise ValueError(msg)
