"""Behave step for registering a worker over HTTP, shared by unported features."""

from __future__ import annotations

from behave import given
from worker_http_helpers import register_worker_http


@given("a worker registered over HTTP as:")
def given_worker_registered_over_http(context: object) -> None:
    register_worker_http(context, context.table)
