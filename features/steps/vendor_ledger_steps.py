"""Behave steps for the per-turn vendor spend ledger."""

from __future__ import annotations

from decimal import Decimal

from behave import given, then, when

from chatticus.vendor_ledger import CompletionUsage
from chatticus.vendor_prices import VendorPrice, register_vendor_price


@given(
    'vendor price for model "{model}" is {input_price} input and '
    "{output_price} output per million tokens"
)
@when(
    'vendor price for model "{model}" is {input_price} input and '
    "{output_price} output per million tokens"
)
def given_vendor_price(
    context: object,
    model: str,
    input_price: str,
    output_price: str,
) -> None:
    register_vendor_price(
        "openai",
        model,
        VendorPrice(
            input_per_million_usd=Decimal(input_price),
            output_per_million_usd=Decimal(output_price),
        ),
    )


@when(
    'bot "{bot_name}" runs one vendor-ledger computerless worker turn '
    'with model "{model}"'
)
def when_vendor_ledger_worker_turn(context: object, bot_name: str, model: str) -> None:
    from browser_auth_helpers import wire_test_http_front_door

    from chatticus.http.client import HttpTurnClient
    from chatticus.worker.computerless import (
        ComputerlessWorker,
        FakeTextCompletionClient,
    )

    bot = context.bots_by_name[bot_name]
    wire_test_http_front_door(context, context.plane, invoke_key="")
    worker = ComputerlessWorker(
        context.plane,
        HttpTurnClient(context.api_client, bot.tenant_id),
        FakeTextCompletionClient(model=model),
    )
    worker.complete_pending_for_bot(bot.bot_id)


@when(
    'vendor spend is recorded for the turn with model "{model}" '
    'and billed_via "{billed_via}"'
)
def when_record_vendor_spend_for_turn(
    context: object, model: str, billed_via: str
) -> None:
    assert context.last_turn_id is not None
    context.plane.record_vendor_spend(
        "anthus",
        context.last_turn_id,
        CompletionUsage(
            vendor="openai",
            model=model,
            input_tokens=10,
            output_tokens=5,
        ),
        billed_via=billed_via,
    )


@when(
    'vendor spend is recorded for turn "{turn_id}" with model "{model}" '
    "and tokens {input_tokens} in {output_tokens} out"
)
def when_record_vendor_spend_for_named_turn(
    context: object,
    turn_id: str,
    model: str,
    input_tokens: str,
    output_tokens: str,
) -> None:
    context.plane.record_vendor_spend(
        "anthus",
        turn_id,
        CompletionUsage(
            vendor="openai",
            model=model,
            input_tokens=int(input_tokens),
            output_tokens=int(output_tokens),
        ),
        billed_via="vendor",
    )


@then('the vendor ledger row for the turn has billed_via "{billed_via}"')
def then_ledger_billed_via(context: object, billed_via: str) -> None:
    row = _ledger_row(context)
    assert row is not None
    assert row.billed_via == billed_via


@then("the vendor ledger row for the turn has input tokens {count:d}")
def then_ledger_input_tokens(context: object, count: int) -> None:
    row = _ledger_row(context)
    assert row is not None
    assert row.input_tokens == count


@then("the vendor ledger row for the turn has output tokens {count:d}")
def then_ledger_output_tokens(context: object, count: int) -> None:
    row = _ledger_row(context)
    assert row is not None
    assert row.output_tokens == count


@then("the vendor ledger row for the turn has frozen input price {price} per million")
def then_ledger_frozen_input_price(context: object, price: str) -> None:
    row = _ledger_row(context)
    assert row is not None
    assert row.input_price_per_million_usd == Decimal(price)


@then("the vendor ledger row for the turn has frozen output price {price} per million")
def then_ledger_frozen_output_price(context: object, price: str) -> None:
    row = _ledger_row(context)
    assert row is not None
    assert row.output_price_per_million_usd == Decimal(price)


@then("the vendor ledger row for the turn has cost_usd {amount}")
def then_ledger_cost_usd(context: object, amount: str) -> None:
    row = _ledger_row(context)
    assert row is not None
    assert row.cost_usd == Decimal(amount)


@then("the vendor ledger row for the turn has null cost_usd")
def then_ledger_null_cost_usd(context: object) -> None:
    row = _ledger_row(context)
    assert row is not None
    assert row.cost_usd is None


@then("the vendor ledger row for the turn has null frozen prices")
def then_ledger_null_frozen_prices(context: object) -> None:
    row = _ledger_row(context)
    assert row is not None
    assert row.input_price_per_million_usd is None
    assert row.output_price_per_million_usd is None


@then('the vendor ledger row for turn "{turn_id}" has input tokens {count:d}')
def then_named_turn_input_tokens(context: object, turn_id: str, count: int) -> None:
    row = context.plane.vendor_ledger_row("anthus", turn_id)
    assert row is not None
    assert row.input_tokens == count


@then('the vendor ledger row for turn "{turn_id}" has output tokens {count:d}')
def then_named_turn_output_tokens(context: object, turn_id: str, count: int) -> None:
    row = context.plane.vendor_ledger_row("anthus", turn_id)
    assert row is not None
    assert row.output_tokens == count


@then(
    'the vendor ledger row for turn "{turn_id}" has frozen input price '
    "{price} per million"
)
def then_named_turn_frozen_input_price(
    context: object, turn_id: str, price: str
) -> None:
    row = context.plane.vendor_ledger_row("anthus", turn_id)
    assert row is not None
    assert row.input_price_per_million_usd == Decimal(price)


@then(
    'the vendor ledger row for turn "{turn_id}" has frozen output price '
    "{price} per million"
)
def then_named_turn_frozen_output_price(
    context: object, turn_id: str, price: str
) -> None:
    row = context.plane.vendor_ledger_row("anthus", turn_id)
    assert row is not None
    assert row.output_price_per_million_usd == Decimal(price)


@then('the vendor ledger row for turn "{turn_id}" has cost_usd {amount}')
def then_named_turn_cost_usd(context: object, turn_id: str, amount: str) -> None:
    row = context.plane.vendor_ledger_row("anthus", turn_id)
    assert row is not None
    assert row.cost_usd == Decimal(amount)


def _ledger_row(context: object):
    assert context.last_turn_id is not None
    return context.plane.vendor_ledger_row("anthus", context.last_turn_id)
