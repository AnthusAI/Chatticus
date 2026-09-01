"""Step definitions for the public brand and product workspace contract."""

from __future__ import annotations

from pathlib import Path

from behave import given, then, when

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def read_text(path: str) -> str:
    """Read a UTF-8 project file from the repository root."""
    return (REPOSITORY_ROOT / path).read_text(encoding="utf-8")


def marketing_source() -> str:
    """Return the authored marketing page, components, and style contract."""
    component_source = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((REPOSITORY_ROOT / "marketing/components").glob("*.tsx"))
    )
    return "\n".join(
        [
            read_text("marketing/app/page.tsx"),
            read_text("marketing/app/layout.tsx"),
            read_text("marketing/app/globals.css"),
            component_source,
        ]
    )


def workspace_source() -> str:
    """Return the authored product workspace and style contract."""
    component_source = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((REPOSITORY_ROOT / "web/components").glob("*.tsx"))
    )
    return "\n".join(
        [
            read_text("web/app/page.tsx"),
            read_text("web/app/globals.css"),
            component_source,
        ]
    )


@given("the Chatticus marketing experience")
def given_chatticus_marketing_experience(context: object) -> None:
    context.marketing_source = marketing_source()


@when("a visitor opens the marketing page")
@when("a visitor explores the product story")
@when("a visitor reaches the evidence section")
@when("a visitor uses a narrow viewport or prefers reduced motion")
def when_visitor_explores_marketing(context: object) -> None:
    assert context.marketing_source


@then('the hero says "{promise}"')
def then_hero_says(context: object, promise: str) -> None:
    assert promise in context.marketing_source


@then("the hero introduces visible named teammates")
def then_hero_introduces_named_teammates(context: object) -> None:
    source = context.marketing_source
    assert all(name in source for name in ["Marin", "Nell", "June", "Sol"])
    assert all(
        role in source for role in ["Editor", "Reporter", "Copy Writer", "Illustrator"]
    )
    assert "BotAvatar" in source


@then("the hero offers paths to the product and source")
def then_hero_offers_product_and_source_paths(context: object) -> None:
    source = context.marketing_source
    assert "https://hey.chattic.us" in source
    assert "https://github.com/AnthusAI/Chattic.us" in source


@then("the page explains the shared user-controlled computer")
def then_page_explains_shared_computer(context: object) -> None:
    source = context.marketing_source.lower()
    assert "one shared computer" in source
    assert "boundary you own" in source


@then("the page distinguishes skills, routines, review, and approval")
def then_page_distinguishes_controls(context: object) -> None:
    source = context.marketing_source
    assert all(label in source for label in ["Skill", "Routine", "Review", "Approval"])


@then("teammate motion is tied to meaningful work states")
def then_motion_maps_to_work_states(context: object) -> None:
    source = context.marketing_source
    assert all(
        state in source for state in ["gathering", "drafting", "drawing", "editing"]
    )
    assert "aria-live" in source


@then("shipped capabilities are distinguished from intended capabilities")
def then_capabilities_are_distinguished(context: object) -> None:
    source = context.marketing_source
    assert all(
        heading in source
        for heading in ["Live foundation", "Proven in development", "Designed next"]
    )


@then("the page contains no fabricated customer testimonial")
def then_page_contains_no_fabricated_testimonial(context: object) -> None:
    source = context.marketing_source
    normalized_source = " ".join(source.split())
    assert "not inventing customer quotes or adoption numbers" in normalized_source
    assert "<blockquote" not in source


@then("third-party product claims include source links")
def then_product_claims_include_sources(context: object) -> None:
    source = context.marketing_source
    assert "Read the source" in source
    assert source.count("https://github.com/") >= 4


@then("primary content remains readable without horizontal scrolling")
def then_primary_content_is_responsive(context: object) -> None:
    source = context.marketing_source
    assert "@media (max-width:" in source
    assert "overflow-x: hidden" in source


@then("essential meaning does not depend on animation")
def then_meaning_does_not_depend_on_animation(context: object) -> None:
    source = context.marketing_source
    assert "@media (prefers-reduced-motion: reduce)" in source
    assert "aria-live" in source
    assert "neutral" in source


@given("the Chatticus product workspace")
def given_chatticus_product_workspace(context: object) -> None:
    context.workspace_source = workspace_source()


@when("a user selects a named teammate")
def when_user_selects_named_teammate(context: object) -> None:
    source = context.workspace_source
    assert "handleSelectBot" in source
    assert "selectedBot" in source


@then("chat is the primary work surface")
def then_chat_is_primary(context: object) -> None:
    source = context.workspace_source
    assert "minmax(24rem, 1fr)" in source
    assert 'className="chat panel"' in source


@then("household tasks remain available as secondary work")
def then_tasks_remain_secondary(context: object) -> None:
    source = context.workspace_source
    assert "<TaskList userId={userId}" in source
    assert "Household record" in source


@then("control-plane diagnostics remain available as secondary status")
def then_diagnostics_remain_secondary(context: object) -> None:
    source = context.workspace_source
    assert "<details" in source
    assert "System details" in source
    assert "Turn details" in source


@then("teammate state is communicated with text as well as motion")
def then_teammate_state_uses_text_and_motion(context: object) -> None:
    source = context.workspace_source
    assert "avatarActivity" in source
    assert "activity-label" in source
    assert "aria-live" in source
