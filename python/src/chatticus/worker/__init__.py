"""Worker processes that pull turn jobs from the control plane."""

from chatticus.worker.computer import (
    ComputerWorker,
    FakeComputerActionExecutor,
)
from chatticus.worker.computerless import (
    ComputerlessWorker,
    FakeTextCompletionClient,
    SlowTextCompletionClient,
    TextCompletionClient,
)
from chatticus.worker.openai_completion import (
    OpenAITextCompletionClient,
    completion_client_from_env,
)

__all__ = [
    "ComputerWorker",
    "FakeComputerActionExecutor",
    "ComputerlessWorker",
    "FakeTextCompletionClient",
    "OpenAITextCompletionClient",
    "SlowTextCompletionClient",
    "TextCompletionClient",
    "completion_client_from_env",
]
