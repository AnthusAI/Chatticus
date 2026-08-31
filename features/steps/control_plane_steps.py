"""Step definitions for the Chatticus control-plane product narrative."""

from __future__ import annotations

from datetime import timedelta

from behave import given, then, when

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.test_server import start_test_server
from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.models import (
    AutoReviewRuleKind,
    ComputerDirtyError,
    ComputerNotHydratedError,
    ComputerPolicy,
    CostClass,
    DuplicateBotNameError,
    SnapshotRequiredError,
    WorkerDoesNotHostComputerError,
    WorkerRegistration,
    WorkerTenantMismatchError,
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
    context.plane = ControlPlane(heartbeat_timeout=timedelta(seconds=30))
    app = create_app(context.plane)
    context.api_app = app
    context.app_state = app.state.chatticus
    context.api_client = start_test_server(app)
    context.bots_by_name = {}
    context.last_job = None
    context.last_assignment = None
    context.last_decision = None
    context.registration_error = None
    context.bot_error = None
    context.snapshot_error = None
    context.relocate_error = None
    context.hydrate_error = None
    context.write_error = None
    context.last_channel = None
    context.last_message = None
    context.last_turn_id = None
    context.message_error = None
    context.other_tenant_id = None
    context.listed_messages = None
    context.sse_watcher = None
    context.access_error = None
    context.stream_error = None


@given("an empty control plane with a cpu enqueue hook")
def given_empty_control_plane_with_cpu_enqueue_hook(context: object) -> None:
    context.cpu_enqueued_jobs = []

    def capture(job: object) -> None:
        context.cpu_enqueued_jobs.append(job)

    context.plane = ControlPlane(
        heartbeat_timeout=timedelta(seconds=30),
        turn_enqueued=capture,
    )
    app = create_app(context.plane)
    context.api_app = app
    context.app_state = app.state.chatticus
    context.api_client = start_test_server(app)
    context.bots_by_name = {}
    context.last_job = None
    context.last_assignment = None
    context.last_decision = None
    context.registration_error = None
    context.bot_error = None
    context.snapshot_error = None
    context.relocate_error = None
    context.hydrate_error = None
    context.write_error = None
    context.last_channel = None
    context.last_message = None
    context.last_turn_id = None
    context.message_error = None
    context.other_tenant_id = None
    context.listed_messages = None
    context.sse_watcher = None
    context.access_error = None
    context.stream_error = None


@given("an empty control plane with cpu and computer enqueue hooks")
def given_empty_control_plane_with_cpu_and_computer_hooks(context: object) -> None:
    context.cpu_enqueued_jobs = []
    context.computer_enqueued_jobs = []

    def capture_cpu(job: object) -> None:
        context.cpu_enqueued_jobs.append(job)

    def capture_computer(job: object) -> None:
        context.computer_enqueued_jobs.append(job)

    context.plane = ControlPlane(
        heartbeat_timeout=timedelta(seconds=30),
        turn_enqueued=capture_cpu,
        computer_enqueued=capture_computer,
    )
    app = create_app(context.plane)
    context.api_app = app
    context.app_state = app.state.chatticus
    context.api_client = start_test_server(app)
    context.bots_by_name = {}
    context.last_job = None
    context.last_assignment = None
    context.last_decision = None
    context.registration_error = None
    context.bot_error = None
    context.snapshot_error = None
    context.relocate_error = None
    context.hydrate_error = None
    context.write_error = None
    context.last_channel = None
    context.last_message = None
    context.last_turn_id = None
    context.message_error = None
    context.other_tenant_id = None
    context.listed_messages = None
    context.sse_watcher = None
    context.access_error = None
    context.stream_error = None


@given("the heartbeat timeout is {seconds:d} seconds")
def given_heartbeat_timeout(context: object, seconds: int) -> None:
    context.plane.heartbeat_timeout = timedelta(seconds=seconds)


@given("a worker registered as:")
def given_worker_registered(context: object) -> None:
    context.plane.register_worker(_registration_from_table(context.table))


@when("a worker registers:")
def when_worker_registers(context: object) -> None:
    try:
        context.plane.register_worker(_registration_from_table(context.table))
        context.registration_error = None
    except WorkerTenantMismatchError as error:
        context.registration_error = error


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
    for record in context.plane.all_workers():
        if record.registration.worker_id != worker_id:
            context.plane.heartbeat(record.registration.worker_id)


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
    try:
        context.plane.write_workspace(bot.tenant_id, bot.user_id, path, content)
        context.write_error = None
    except ComputerNotHydratedError as error:
        context.write_error = error


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
    context.plane.remember(bot.tenant_id, bot.bot_id, key, value)


@then('bot "{name}" does not remember "{key}"')
def then_bot_does_not_remember(context: object, name: str, key: str) -> None:
    bot = context.bots_by_name[name]
    assert context.plane.memory(bot.tenant_id, bot.bot_id, key) is None


@when("the control plane is recycled onto the same messaging store")
def when_control_plane_is_recycled(context: object) -> None:
    context.plane = ControlPlane(messaging_store=context.messaging_store)


@then('bot "{name}" has memory "{key}" as "{value}"')
def then_bot_has_memory(context: object, name: str, key: str, value: str) -> None:
    bot = context.bots_by_name[name]
    assert context.plane.memory(bot.tenant_id, bot.bot_id, key) == value


@then('the turn prompt contains memory "{key}" as "{value}"')
def then_turn_prompt_contains_memory(context: object, key: str, value: str) -> None:
    channel = context.last_channel
    prompt = context.plane.turn_prompt(channel.tenant_id, context.last_turn_id)
    assert f"memory {key}: {value}" in prompt.splitlines()


@then('the turn prompt contains channel text "{body}"')
def then_turn_prompt_contains_channel_text(context: object, body: str) -> None:
    channel = context.last_channel
    prompt = context.plane.turn_prompt(channel.tenant_id, context.last_turn_id)
    assert any(line.endswith(body) for line in prompt.splitlines())


@then('bot "{name}" cannot read "{path}" from its computer')
def then_bot_cannot_read(context: object, name: str, path: str) -> None:
    bot = context.bots_by_name[name]
    assert context.plane.read_workspace(bot.tenant_id, bot.user_id, path) is None


@when('a bot proposes action type "{action_type}"')
def when_proposes_action(context: object, action_type: str) -> None:
    context.last_decision = context.plane.evaluate_action(action_type, "anthus")


@when('tenant "{tenant_id}" proposes action type "{action_type}"')
def when_tenant_proposes_action(
    context: object, tenant_id: str, action_type: str
) -> None:
    context.last_decision = context.plane.evaluate_action(action_type, tenant_id)


@then('the decision is "{decision}"')
def then_decision(context: object, decision: str) -> None:
    assert context.last_decision.value == decision


@given('an auto-review rule always-allow for "{action_type}"')
def given_always_allow(context: object, action_type: str) -> None:
    context.plane.add_auto_review_rule(
        AutoReviewRuleKind.ALWAYS_ALLOW, action_type, "anthus"
    )


@given('an auto-review rule require-approval for "{action_type}"')
def given_require_approval(context: object, action_type: str) -> None:
    context.plane.add_auto_review_rule(
        AutoReviewRuleKind.REQUIRE_APPROVAL, action_type, "anthus"
    )


@given('an auto-review rule never-allow for "{action_type}"')
def given_never_allow(context: object, action_type: str) -> None:
    context.plane.add_auto_review_rule(
        AutoReviewRuleKind.NEVER_ALLOW, action_type, "anthus"
    )


@given('tenant "{tenant_id}" has an auto-review rule never-allow for "{action_type}"')
def given_tenant_never_allow(context: object, tenant_id: str, action_type: str) -> None:
    context.plane.add_auto_review_rule(
        AutoReviewRuleKind.NEVER_ALLOW, action_type, tenant_id
    )


@then("worker registration fails because the tenant does not match")
def then_registration_tenant_mismatch(context: object) -> None:
    assert isinstance(context.registration_error, WorkerTenantMismatchError)


@given('tenant "{tenant_id}" user "{user_id}" has computer "{computer_id}"')
def given_computer(
    context: object, tenant_id: str, user_id: str, computer_id: str
) -> None:
    context.plane.ensure_computer(tenant_id, user_id, computer_id=computer_id)


@when('bot "{name}" enqueues a turn:')
def when_bot_enqueues(context: object, name: str) -> None:
    values = _two_column_table_as_dict(context.table)
    required = frozenset(
        item.strip() for item in values["capabilities"].split(",") if item.strip()
    )
    bot = context.bots_by_name[name]
    policy = ComputerPolicy(values["policy"]) if "policy" in values else None
    computer_id = values.get("computer_id") or None
    context.last_job = context.plane.enqueue_turn(
        bot.tenant_id,
        required,
        computer_policy=policy,
        computer_id=computer_id,
        bot_id=bot.bot_id,
    )
    context.last_assignment = context.plane.assign_turn(context.last_job)


@when('I create a bot named "{name}" for tenant "{tenant_id}" user "{user_id}"')
def when_create_bot(context: object, name: str, tenant_id: str, user_id: str) -> None:
    try:
        bot = context.plane.create_bot(tenant_id, user_id, name)
        context.bots_by_name[name] = bot
        context.bot_error = None
    except DuplicateBotNameError as error:
        context.bot_error = error


@when(
    'tenant "{tenant_id}" user "{user_id}" creates bot "{name}" '
    'using idempotency key "{key}"'
)
def when_create_bot_with_idempotency(
    context: object, name: str, tenant_id: str, user_id: str, key: str
) -> None:
    previous = getattr(context, "idempotent_bot_id", None)
    bot = context.plane.create_bot(tenant_id, user_id, name, idempotency_key=key)
    context.bots_by_name[name] = bot
    context.bot_error = None
    if previous is None:
        context.idempotent_bot_id = bot.bot_id
    else:
        context.repeated_bot_id = bot.bot_id


@given("an empty control plane backed by a durable messaging store")
def given_durable_messaging_store(context: object) -> None:
    context.messaging_store = InMemoryMessagingStore()
    context.plane = ControlPlane(messaging_store=context.messaging_store)
    context.bots_by_name = {}


@given("an empty control plane backed by a durable messaging store with HTTP")
def given_durable_messaging_store_with_http(context: object) -> None:
    context.messaging_store = InMemoryMessagingStore()
    context.plane = ControlPlane(messaging_store=context.messaging_store)
    app = create_app(context.plane)
    context.api_app = app
    context.app_state = app.state.chatticus
    context.api_client = start_test_server(app)
    context.bots_by_name = {}
    context.opened_channel_ids = []
    context.last_channel = None
    context.last_turn_id = None
    context.message_error = None
    context.other_tenant_id = None
    context.listed_messages = None
    context.access_error = None


@when("a recycled Front Door serves the same messaging store")
def when_recycled_front_door(context: object) -> None:
    context.api_client.close()
    context.plane = ControlPlane(messaging_store=context.messaging_store)
    app = create_app(context.plane)
    context.api_app = app
    context.app_state = app.state.chatticus
    context.api_client = start_test_server(app)


@when(
    'a new control plane instance creates a bot named "{name}" '
    'for tenant "{tenant_id}" user "{user_id}"'
)
def when_recycled_plane_creates_bot(
    context: object, name: str, tenant_id: str, user_id: str
) -> None:
    context.plane = ControlPlane(messaging_store=context.messaging_store)
    when_create_bot(context, name, tenant_id, user_id)


@when(
    'a recycled control plane creates bot "{name}" for tenant '
    '"{tenant_id}" user "{user_id}" using idempotency key "{key}"'
)
def when_recycled_plane_creates_bot_with_idempotency(
    context: object, name: str, tenant_id: str, user_id: str, key: str
) -> None:
    context.plane = ControlPlane(messaging_store=context.messaging_store)
    when_create_bot_with_idempotency(context, name, tenant_id, user_id, key)


@then("creating the bot fails because the name is already used")
def then_duplicate_bot(context: object) -> None:
    assert isinstance(context.bot_error, DuplicateBotNameError)


@then("the created bot identifier is unchanged")
def then_created_bot_identifier_is_unchanged(context: object) -> None:
    first = getattr(context, "idempotent_bot_id", None)
    second = getattr(context, "repeated_bot_id", None)
    assert first is not None
    assert second == first


@then('tenant "{tenant_id}" can look up bot "{name}" for user "{user_id}"')
def then_lookup_bot_by_name(
    context: object, tenant_id: str, name: str, user_id: str
) -> None:
    expected = context.bots_by_name[name]
    response = context.api_client.get(
        "/bots",
        params={"user_id": user_id, "name": name},
        headers={"X-Tenant-Id": tenant_id},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["bot_id"] == expected.bot_id
    assert payload["name"] == name
    assert payload["user_id"] == user_id


@then('tenant "{tenant_id}" can list bots for user "{user_id}":')
def then_list_user_bots(context: object, tenant_id: str, user_id: str) -> None:
    expected_names: list[str] = []
    if context.table.headings and context.table.headings[0].strip():
        expected_names.append(context.table.headings[0].strip())
    expected_names.extend(row.cells[0].strip() for row in context.table)
    expected_names = [name for name in expected_names if name]
    response = context.api_client.get(
        f"/users/{user_id}/bots",
        headers={"X-Tenant-Id": tenant_id},
    )
    assert response.status_code == 200
    names = [bot["name"] for bot in response.json()["bots"]]
    assert names == expected_names
    for name in expected_names:
        expected = context.bots_by_name[name]
        payload = next(bot for bot in response.json()["bots"] if bot["name"] == name)
        assert payload["bot_id"] == expected.bot_id
        assert payload["user_id"] == user_id


@when('worker "{worker_id}" publishes a snapshot of computer "{computer_id}"')
def when_publish_snapshot(context: object, worker_id: str, computer_id: str) -> None:
    try:
        context.plane.publish_snapshot(computer_id, worker_id)
        context.snapshot_error = None
    except (ComputerNotHydratedError, WorkerDoesNotHostComputerError) as error:
        context.snapshot_error = error


@when('an administrator relocates computer "{computer_id}" to worker "{worker_id}"')
def when_relocate_computer(context: object, computer_id: str, worker_id: str) -> None:
    try:
        context.plane.relocate_computer(computer_id, worker_id)
        context.relocate_error = None
    except (SnapshotRequiredError, ComputerDirtyError) as error:
        context.relocate_error = error


@when('worker "{worker_id}" hydrates computer "{computer_id}"')
def when_hydrate_computer(context: object, worker_id: str, computer_id: str) -> None:
    try:
        context.plane.hydrate_computer(computer_id, worker_id)
        context.hydrate_error = None
    except (
        SnapshotRequiredError,
        WorkerDoesNotHostComputerError,
    ) as error:
        context.hydrate_error = error


@then('computer "{computer_id}" has snapshot URI "{snapshot_uri}"')
def then_snapshot_uri(context: object, computer_id: str, snapshot_uri: str) -> None:
    computer = context.plane.computer_by_id(computer_id)
    assert computer.snapshot_uri == snapshot_uri


@then('computer "{computer_id}" is not dirty')
def then_computer_not_dirty(context: object, computer_id: str) -> None:
    assert context.plane.computer_by_id(computer_id).disk_dirty is False


@then('computer "{computer_id}" does not require hydrate')
def then_computer_not_hydrate_required(context: object, computer_id: str) -> None:
    computer = context.plane.computer_by_id(computer_id)
    assert computer.hydrate_required is False
    assert computer.intended_host_worker_id is None


@then("relocate fails because a snapshot is required")
def then_relocate_snapshot_required(context: object) -> None:
    assert isinstance(context.relocate_error, SnapshotRequiredError)


@then("relocate fails because the disk is dirty")
def then_relocate_dirty(context: object) -> None:
    assert isinstance(context.relocate_error, ComputerDirtyError)


@then("hydrate fails because the worker does not host that computer")
def then_hydrate_wrong_host(context: object) -> None:
    assert isinstance(context.hydrate_error, WorkerDoesNotHostComputerError)


@then("writing the computer fails because it is not hydrated")
def then_write_not_hydrated(context: object) -> None:
    assert isinstance(context.write_error, ComputerNotHydratedError)
