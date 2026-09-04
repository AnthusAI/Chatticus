"""Behave steps for marketing blog (Updates and Agent Zoo)."""

from __future__ import annotations

import re

from behave import given, then
from marketing_positioning_steps import _run_harness

FOOTER_PATTERN = re.compile(
    r"<footer[^>]*>(.*?)</footer>",
    re.DOTALL | re.IGNORECASE,
)

FOOTER_GROUP_PATTERN = re.compile(
    r"<h2[^>]*>\s*(?P<title>[^<]+?)\s*</h2>\s*<ul[^>]*>(?P<links>.*?)</ul>",
    re.DOTALL | re.IGNORECASE,
)

FOOTER_LINK_PATTERN = re.compile(
    r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
    re.DOTALL | re.IGNORECASE,
)

PAGE_LINK_PATTERN = re.compile(
    r'<a\b[^>]*href="(?P<href>/[^"]+)"',
    re.IGNORECASE,
)


def _visible_text(context: object) -> str:
    return context.marketing_ui_harness.get("visibleText") or ""


def _html(context: object) -> str:
    return context.marketing_ui_harness.get("html") or ""


def _footer_html(context: object) -> str:
    html = _html(context)
    match = FOOTER_PATTERN.search(html)
    assert match is not None, "Footer not found in rendered HTML"
    return match.group(1)


def _news_group_links(context: object) -> list[tuple[str, str]]:
    footer_html = _footer_html(context)
    for group_match in FOOTER_GROUP_PATTERN.finditer(footer_html):
        title = group_match.group("title").strip()
        if title.lower() != "news":
            continue
        links_html = group_match.group("links")
        links: list[tuple[str, str]] = []
        for link_match in FOOTER_LINK_PATTERN.finditer(links_html):
            href = link_match.group(1)
            label = re.sub(r"<[^>]+>", "", link_match.group(2))
            label = " ".join(label.split())
            links.append((label, href))
        return links
    raise AssertionError('Footer group "News" not found')


def _normalize_href(href: str) -> str:
    return href.rstrip("/") or "/"


def _page_has_href(context: object, expected_path: str) -> None:
    html = _html(context)
    normalized = _normalize_href(expected_path)
    for match in PAGE_LINK_PATTERN.finditer(html):
        href = _normalize_href(match.group("href"))
        if href == normalized:
            return
    raise AssertionError(f"No link to {expected_path!r} found in page HTML")


@given("a visitor on the Updates page")
def given_visitor_on_updates_page(context: object) -> None:
    context.marketing_ui_harness = _run_harness("render-updates")


@given("a visitor on the Agent Zoo page")
def given_visitor_on_agent_zoo_page(context: object) -> None:
    context.marketing_ui_harness = _run_harness("render-agent-zoo")


@given('a visitor on the Updates post "{slug}"')
def given_visitor_on_updates_post(context: object, slug: str) -> None:
    context.marketing_ui_harness = _run_harness("render-post", "updates", slug)


@given('a visitor on the Agent Zoo post "{slug}"')
def given_visitor_on_agent_zoo_post(context: object, slug: str) -> None:
    context.marketing_ui_harness = _run_harness("render-post", "agent-zoo", slug)


@then("the footer has a News group")
def then_footer_has_news_group(context: object) -> None:
    _news_group_links(context)


@then('the News group lists Updates linking to "/updates"')
def then_news_group_lists_updates(context: object) -> None:
    links = _news_group_links(context)
    for label, href in links:
        if label == "Updates":
            assert (
                _normalize_href(href) == "/updates"
            ), f'Updates link expected "/updates", got {href!r}'
            return
    raise AssertionError('News group does not list "Updates"')


@then('the News group lists Agent Zoo linking to "/agent-zoo"')
def then_news_group_lists_agent_zoo(context: object) -> None:
    links = _news_group_links(context)
    for label, href in links:
        if label == "Agent Zoo":
            assert (
                _normalize_href(href) == "/agent-zoo"
            ), f'Agent Zoo link expected "/agent-zoo", got {href!r}'
            return
    raise AssertionError('News group does not list "Agent Zoo"')


@then("Updates appears before Agent Zoo in that group")
def then_updates_before_agent_zoo_in_news_group(context: object) -> None:
    links = _news_group_links(context)
    labels = [label for label, _href in links]
    assert "Updates" in labels, labels
    assert "Agent Zoo" in labels, labels
    assert labels.index("Updates") < labels.index("Agent Zoo"), labels


@then("the page states that Updates is progress notes about Chatticus itself")
def then_updates_page_states_progress_notes(context: object) -> None:
    text = _visible_text(context).lower()
    assert "progress notes" in text, text
    assert "chatticus" in text, text


@then('the page lists "{title}" linking to "{path}"')
def then_page_lists_title_linking_to_path(
    context: object, title: str, path: str
) -> None:
    html = _html(context)
    text = _visible_text(context)
    assert title in text, text
    normalized = _normalize_href(path)
    for match in FOOTER_LINK_PATTERN.finditer(html):
        href = _normalize_href(match.group(1))
        label = re.sub(r"<[^>]+>", "", match.group(2))
        label = " ".join(label.split())
        if href == normalized and title in label:
            return
    raise AssertionError(f"No link titled {title!r} to {path!r} found")


@then("the page does not say coming soon")
def then_page_does_not_say_coming_soon(context: object) -> None:
    text = _visible_text(context).lower()
    assert "coming soon" not in text, text


@then("the page is titled Agent Zoo")
def then_page_is_titled_agent_zoo(context: object) -> None:
    text = _visible_text(context)
    assert "Agent Zoo" in text, text


@then('the page is titled "{title}"')
def then_page_is_titled(context: object, title: str) -> None:
    text = _visible_text(context)
    assert title in text, text


@then(
    "the page states that Agent Zoo covers workplaces where agents "
    "collaborate and do useful work"
)
def then_agent_zoo_page_states_category_beat(context: object) -> None:
    text = _visible_text(context).lower()
    assert "collaborate" in text, text
    assert "useful work" in text, text


@then("the page does not call itself a model zoo")
def then_page_does_not_call_itself_model_zoo(context: object) -> None:
    text = _visible_text(context)
    assert "Agent Zoo" in text, text
    assert "model zoo" not in text.lower(), text


@then("the page states that the industry has not settled on a word")
def then_page_states_industry_has_not_settled_on_a_word(context: object) -> None:
    text = _visible_text(context).lower()
    assert "has not settled on a word" in text, text


@then('the page links to "{path}"')
def then_page_links_to_path(context: object, path: str) -> None:
    _page_has_href(context, path)


@then("the page states that named teammates share one computer")
def then_page_states_named_teammates_share_one_computer(context: object) -> None:
    text = _visible_text(context).lower()
    assert "named" in text, text
    assert "computer" in text, text


@then("the page states that the computer is summoned when a turn needs it")
def then_page_states_computer_is_summoned(context: object) -> None:
    text = _visible_text(context).lower()
    assert "summoned" in text, text


@then("the page states that Chatticus is a farm of desks")
def then_page_states_chatticus_is_a_farm_of_desks(context: object) -> None:
    text = _visible_text(context).lower()
    assert "farm of desks" in text, text


@then("the page states that a standing team is the default picture")
def then_page_states_standing_team_is_default_picture(context: object) -> None:
    text = _visible_text(context).lower()
    assert "standing" in text, text
    assert "team" in text, text
    assert "default" in text, text


@then("the page states that people share the workplace with the bots")
def then_page_states_people_share_workplace_with_bots(context: object) -> None:
    text = _visible_text(context).lower()
    assert "organization" in text, text
    assert "bots" in text, text
