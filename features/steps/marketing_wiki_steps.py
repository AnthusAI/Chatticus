"""Behave steps for marketing wiki."""

from __future__ import annotations

import re

from behave import given, then
from marketing_blog_steps import (
    FOOTER_LINK_PATTERN,
    _footer_html,
    _news_group_links,
    _visible_text,
)
from marketing_positioning_steps import _run_harness

WIKI_ARTICLE_LINK_PATTERN = re.compile(r'href="/wiki/[^"]+"', re.IGNORECASE)

ROBOTS_NOINDEX_PATTERN = re.compile(
    r'<meta[^>]+name=["\']robots["\'][^>]+content=["\'][^"\']*noindex',
    re.IGNORECASE,
)


def _html(context: object) -> str:
    return context.marketing_ui_harness.get("html") or ""


@given("a visitor on the wiki page")
def given_visitor_on_wiki_page(context: object) -> None:
    context.marketing_ui_harness = _run_harness("render-wiki")


@then("the footer does not list a Wiki link")
def then_footer_does_not_list_wiki_link(context: object) -> None:
    footer_html = _footer_html(context)
    for link_match in FOOTER_LINK_PATTERN.finditer(footer_html):
        label = re.sub(r"<[^>]+>", "", link_match.group(2))
        label = " ".join(label.split())
        assert label.lower() != "wiki", f"Footer lists a Wiki link: {label!r}"


@then("the News group does not list Wiki")
def then_news_group_does_not_list_wiki(context: object) -> None:
    links = _news_group_links(context)
    labels = [label for label, _href in links]
    assert not any(label.lower() == "wiki" for label in labels), labels


@then("the page states that the wiki is durable notes about agent workplaces")
def then_wiki_page_states_durable_notes_about_agent_workplaces(context: object) -> None:
    text = _visible_text(context).lower()
    assert "durable notes" in text, text
    assert "agent workplaces" in text, text


@then("the page describes general ideas")
def then_wiki_page_describes_general_ideas(context: object) -> None:
    text = _visible_text(context).lower()
    assert "general ideas" in text, text


@then("the page lists no wiki pages yet")
def then_page_lists_no_wiki_pages_yet(context: object) -> None:
    html = _html(context)
    assert (
        WIKI_ARTICLE_LINK_PATTERN.search(html) is None
    ), f"Unexpected wiki article link found: {WIKI_ARTICLE_LINK_PATTERN.pattern}"


@then("the page is marked noindex")
def then_page_is_marked_noindex(context: object) -> None:
    html = _html(context)
    assert ROBOTS_NOINDEX_PATTERN.search(html) is not None, html
