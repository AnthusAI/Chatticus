"""Step definitions for the Chatticus control-plane product narrative."""

from __future__ import annotations

from datetime import timedelta

from behave import given, then, when

from chatticus.models import (
    AutoReviewRuleKind,
    ComputerPolicy,
    CostClass,
    WorkerRegistration,
)


def _two_column_table_as_dict(table: object) -> dict[str, str]:
    values = {table.headings[0].strip(): table.headings[1].strip()}
    for row in table:
        values[row.cells[0].strip()] = row.cells[1].strip()
    return values


def _registration_from_table(table: object) -> WorkerRegistration:
    values = _two_column_table_as_dict(table)
    capabilities = frozenset(
        item.strip() for item in values["capabilities"].split(",") if item.strip()
    )
    return WorkerRegistration(
        worker_id=values["worker_id"],
        tenant_id=values["tenant_id"],
        cost_class=CostClass(values["cost_class"]),
        capabilities=capabilities,
        computer_id=values.get("computer_id") or None,
    )


@given("an empty control plane")
def given_empty_control_plane(context: object) -> None:
    context.plane.set_now(context.plane.now())


@given("the heartbeat timeout is {seconds:d} seconds")
def given_heartbeat_timeout(context: object, seconds: int) -> None:
    context.plane.heartbeat_timeout = timedelta(seconds=seconds)


@given("a worker registered as:")
def given_worker_registered(context: object) -> None:
    context.plane.register_worker(_registration_from_table(context.table))


@when("a worker registers:")
def when_worker_registers(context: object) -> None:
    context.plane.register_worker(_registration_from_table(context.table))


@when("{seconds:d} seconds pass")
def when_seconds_pass(context: object, seconds: int) -> None:
    context.plane.advance_seconds(seconds)


@when("{seconds:d} more seconds pass")
def when_more_seconds_pass(context: object, seconds: int) -> None:
    context.plane.advance_seconds(seconds)


@when('{seconds:d} seconds pass without a heartbeat from "{worker_id}"')
def when_seconds_pass_without_heartbeat(
    context: object, seconds: int, worker_id: str
) -> None:
    context.plane.advance_seconds(seconds)
    context.plane.heartbeat_all_except(worker_id)


@when('worker "{worker_id}" sends a heartbeat')
def when_worker_heartbeats(context: object, worker_id: str) -> None:
    context.plane.heartbeat(worker_id)


@then('tenant "{tenant_id}" has {count:d} healthy worker')
def then_healthy_worker_count_one(context: object, tenant_id: str, count: int) -> None:
    assert len(context.plane.healthy_workers(tenant_id)) == count


@then('tenant "{tenant_id}" has {count:d} healthy workers')
def then_healthy_worker_count(context: object, tenant_id: str, count: int) -> None:
    assert len(context.plane.healthy_workers(tenant_id)) == count


@then('worker "{worker_id}" has cost class "{cost_class}"')
def then_worker_cost_class(context: object, worker_id: str, cost_class: str) -> None:
    record = context.plane.worker(worker_id)
    assert record.registration.cost_class == CostClass(cost_class)


@then('worker "{worker_id}" has computer affinity "{computer_id}"')
def then_worker_computer_affinity(
    context: object, worker_id: str, computer_id: str
) -> None:
    record = context.plane.worker(worker_id)
    assert record.registration.computer_id == computer_id


@when('tenant "{tenant_id}" enqueues a turn:')
def when_enqueue_turn(context: object, tenant_id: str) -> None:
    values = _two_column_table_as_dict(context.table)
    required = frozenset(
        item.strip() for item in values["capabilities"].split(",") if item.strip()
    )
    policy = (
        ComputerPolicy(values["policy"])
        if "policy" in values
        else ComputerPolicy.PREFER_LOCAL
    )
    computer_id = values.get("computer_id") or None
    context.last_job = context.plane.enqueue_turn(
        tenant_id,
        required,
        computer_policy=policy,
        computer_id=computer_id,
    )
    context.last_assignment = context.plane.assign_turn(context.last_job)


@then('the turn is assigned to worker "{worker_id}"')
def then_assigned_to(context: object, worker_id: str) -> None:
    assert context.last_assignment is not None
    assert context.last_assignment.worker_id == worker_id


@then("the turn is not assigned")
def then_not_assigned(context: object) -> None:
    assert context.last_assignment is None


@given('tenant "{tenant_id}" user "{user_id}" has a bot named "{name}"')
def given_bot(context: object, tenant_id: str, user_id: str, name: str) -> None:
    bot = context.plane.create_bot(tenant_id, user_id, name)
    context.bots_by_name[name] = bot


@when('bot "{name}" writes "{path}" containing "{content}" on the computer')
def when_bot_writes_workspace(
    context: object, name: str, path: str, content: str
) -> None:
    bot = context.bots_by_name[name]
    context.plane.write_workspace(bot.tenant_id, bot.user_id, path, content)


@then('bot "{name}" can read "{path}" as "{content}" from the computer')
def then_bot_reads_workspace(
    context: object, name: str, path: str, content: str
) -> None:
    bot = context.bots_by_name[name]
    assert context.plane.read_workspace(bot.tenant_id, bot.user_id, path) == content


@then("both bots use the same computer")
def then_same_computer(context: object) -> None:
    bots = list(context.bots_by_name.values())
    computers = {
        context.plane.computer_for_user(bot.tenant_id, bot.user_id).computer_id
        for bot in bots
    }
    assert len(computers) == 1


@when('bot "{name}" saves a browser session "{service}" as "{session}"')
def when_save_session(context: object, name: str, service: str, session: str) -> None:
    bot = context.bots_by_name[name]
    context.plane.save_browser_session(bot.tenant_id, bot.user_id, service, session)


@then('bot "{name}" sees browser session "{service}" as "{session}"')
def then_sees_session(context: object, name: str, service: str, session: str) -> None:
    bot = context.bots_by_name[name]
    assert context.plane.browser_session(bot.tenant_id, bot.user_id, service) == session


@when('bot "{name}" remembers "{key}" as "{value}"')
def when_bot_remembers(context: object, name: str, key: str, value: str) -> None:
    bot = context.bots_by_name[name]
    context.plane.remember(bot.bot_id, key, value)


@then('bot "{name}" does not remember "{key}"')
def then_bot_does_not_remember(context: object, name: str, key: str) -> None:
    bot = context.bots_by_name[name]
    assert context.plane.memory(bot.bot_id, key) is None


@then('bot "{name}" cannot read "{path}" from its computer')
def then_bot_cannot_read(context: object, name: str, path: str) -> None:
    bot = context.bots_by_name[name]
    assert context.plane.read_workspace(bot.tenant_id, bot.user_id, path) is None


@when('a bot proposes action type "{action_type}"')
def when_proposes_action(context: object, action_type: str) -> None:
    context.last_decision = context.plane.evaluate_action(action_type)


@then('the decision is "{decision}"')
def then_decision(context: object, decision: str) -> None:
    assert context.last_decision.value == decision


@given('an auto-review rule always-allow for "{action_type}"')
def given_always_allow(context: object, action_type: str) -> None:
    context.plane.add_auto_review_rule(AutoReviewRuleKind.ALWAYS_ALLOW, action_type)


@given('an auto-review rule require-approval for "{action_type}"')
def given_require_approval(context: object, action_type: str) -> None:
    context.plane.add_auto_review_rule(AutoReviewRuleKind.REQUIRE_APPROVAL, action_type)


@given('an auto-review rule never-allow for "{action_type}"')
def given_never_allow(context: object, action_type: str) -> None:
    context.plane.add_auto_review_rule(AutoReviewRuleKind.NEVER_ALLOW, action_type)
