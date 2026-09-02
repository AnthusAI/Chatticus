"""Thin Task item kernel for v1 durable job state outside the channel.

Task rows live in the Chatticus messaging store (DynamoDB in production).
The structured ``task`` tool is available at the first readiness gate so a
computerless worker can create, read, and close tasks without summoning a
browser.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from chatticus.control_plane import ControlPlane
from chatticus.models import (
    Task,
    TaskAccessDeniedError,
    TaskEvidenceRequiredError,
    TaskNotFoundError,
)

TASK_TOOL_NAME = "task"


@dataclass(frozen=True)
class TaskToolResult:
    """Outcome of one structured task-tool invocation."""

    action: str
    task: Task | None = None
    computer_summoned: bool = False


@dataclass
class ThinTaskDriver:
    """Drive task-tool scenarios from Gherkin and kernel tests."""

    plane: ControlPlane | None = None
    tenant_id: str = "anthus"
    user_id: str = "ryan"
    bot_name: str = "Assistant"
    last_task: Task | None = None
    last_error: Exception | None = None
    computer_summoned: bool = False

    def __post_init__(self) -> None:
        if self.plane is None:
            self.plane = ControlPlane()

    def given_stopped_computer(self) -> None:
        """Mark the household computer stopped."""
        self.plane.set_computer_stopped(self.tenant_id, True)

    def ensure_bot(self, name: str | None = None) -> str:
        """Return the named bot id, creating it if needed."""
        bot_name = name or self.bot_name
        try:
            bot = self.plane.bot_by_name(self.tenant_id, bot_name)
        except KeyError:
            bot = self.plane.create_bot(
                self.tenant_id, bot_name, creator_user_id=self.user_id
            )
        self.bot_name = bot_name
        return bot.bot_id

    def create_task_via_tool(self, title: str, *, bot_name: str | None = None) -> Task:
        """Invoke the structured task tool to open one task."""
        bot_id = self.ensure_bot(bot_name)
        result = invoke_task_tool(
            self.plane,
            tenant_id=self.tenant_id,
            user_id=self.user_id,
            bot_id=bot_id,
            action="create",
            arguments={"title": title},
        )
        assert result.task is not None
        self.last_task = result.task
        self.computer_summoned = result.computer_summoned
        return result.task

    def given_open_task(self, title: str, *, bot_name: str | None = None) -> Task:
        """Seed an open task owned by the bot."""
        return self.create_task_via_tool(title, bot_name=bot_name)

    def try_complete_without_evidence(self, *, bot_name: str | None = None) -> None:
        """Attempt to mark the last task completed with no evidence."""
        assert self.last_task is not None
        bot_id = self.ensure_bot(bot_name)
        self.last_error = None
        try:
            invoke_task_tool(
                self.plane,
                tenant_id=self.tenant_id,
                user_id=self.user_id,
                bot_id=bot_id,
                action="complete",
                arguments={"task_id": self.last_task.task_id},
            )
        except TaskEvidenceRequiredError as error:
            self.last_error = error

    def complete_task(self, evidence: str, *, bot_name: str | None = None) -> Task:
        """Complete the last task with durable evidence."""
        assert self.last_task is not None
        bot_id = self.ensure_bot(bot_name)
        result = invoke_task_tool(
            self.plane,
            tenant_id=self.tenant_id,
            user_id=self.user_id,
            bot_id=bot_id,
            action="complete",
            arguments={"task_id": self.last_task.task_id, "evidence": evidence},
        )
        assert result.task is not None
        self.last_task = result.task
        return result.task

    def close_task(self, reason: str, *, bot_name: str | None = None) -> Task:
        """Close the last task with a recorded reason."""
        assert self.last_task is not None
        bot_id = self.ensure_bot(bot_name)
        result = invoke_task_tool(
            self.plane,
            tenant_id=self.tenant_id,
            user_id=self.user_id,
            bot_id=bot_id,
            action="close",
            arguments={"task_id": self.last_task.task_id, "reason": reason},
        )
        assert result.task is not None
        self.last_task = result.task
        return result.task

    def try_read_from_other_tenant(self) -> None:
        """Another tenant attempts to read the last task."""
        assert self.last_task is not None
        self.last_error = None
        try:
            self.plane.task("other-household", self.last_task.task_id)
        except (TaskNotFoundError, TaskAccessDeniedError) as error:
            self.last_error = error


def invoke_task_tool(
    plane: ControlPlane,
    *,
    tenant_id: str,
    user_id: str,
    bot_id: str,
    action: str,
    arguments: dict[str, str],
) -> TaskToolResult:
    """Dispatch one structured task-tool call at the first readiness gate."""
    jobs_before = len(plane.pending_jobs())
    task = plane.invoke_task_tool(
        tenant_id,
        user_id,
        bot_id,
        action,
        arguments,
    )
    return TaskToolResult(
        action=action,
        task=task,
        computer_summoned=len(plane.pending_jobs()) > jobs_before,
    )


def task_tool_schema() -> dict[str, Any]:
    """Return the v1 structured tool shape exposed to the model."""
    return {
        "name": TASK_TOOL_NAME,
        "readiness_gate": "first",
        "actions": ["create", "get", "complete", "close"],
        "fields": ["status", "evidence", "close_reason", "bot_provenance"],
    }


def openai_task_tool() -> dict[str, Any]:
    """Return the OpenAI function tool definition for the task tool."""
    return {
        "type": "function",
        "function": {
            "name": TASK_TOOL_NAME,
            "description": (
                "Create, read, complete, or close a durable household task. "
                "Use for job tracking without summoning the computer."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "get", "complete", "close"],
                    },
                    "title": {
                        "type": "string",
                        "description": "Required for create.",
                    },
                    "task_id": {
                        "type": "string",
                        "description": "Required for get, complete, and close.",
                    },
                    "evidence": {
                        "type": "string",
                        "description": "Required for complete.",
                    },
                    "reason": {
                        "type": "string",
                        "description": "Required for close.",
                    },
                },
                "required": ["action"],
            },
        },
    }
