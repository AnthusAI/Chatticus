"""Behave steps for marketing wiki."""

from __future__ import annotations

import re

from behave import given, then
from marketing_blog_steps import (
    _html,
    _news_group_links,
    _normalize_href,
    _visible_text,
)
from marketing_footer_steps import _footer_links
from marketing_positioning_steps import _run_harness

ROBOTS_NOINDEX_PATTERN = re.compile(
    r'<meta[^>]+name=["\']robots["\'][^>]+content=["\'][^"\']*noindex',
    re.IGNORECASE,
)

GITHUB_BLOB_PATTERN = re.compile(
    r"https://github\.com/AnthusAI/Chattic\.us/blob/[^\"\s]+",
    re.IGNORECASE,
)

MARKUS_DOCUMENT_PATTERN = re.compile(
    r'class="[^"]*\bmarkus-document\b',
    re.IGNORECASE,
)

CHATTICUS_THEME_PATTERN = re.compile(
    r'data-theme="chatticus"|class="[^"]*\bmarkus-theme-chatticus\b',
    re.IGNORECASE,
)


@given("a visitor on the wiki page")
def given_visitor_on_wiki_page(context: object) -> None:
    context.marketing_ui_harness = _run_harness("render-wiki")


@given('a visitor on the wiki page "{slug}"')
def given_visitor_on_wiki_slug(context: object, slug: str) -> None:
    context.marketing_ui_harness = _run_harness("render-wiki-page", slug)


@then('the footer lists {label} linking to "{href}"')
def then_footer_lists_label_linking_to_href(
    context: object, label: str, href: str
) -> None:
    expected_href = _normalize_href(href)
    for link_label, link_href in _footer_links(context):
        if link_label == label:
            assert (
                _normalize_href(link_href) == expected_href
            ), f"{label} link expected {href!r}, got {link_href!r}"
            return
    raise AssertionError(f"Footer does not list {label!r}")


@then("the News group does not list Wiki")
def then_news_group_does_not_list_wiki(context: object) -> None:
    links = _news_group_links(context)
    labels = [label for label, _href in links]
    assert not any(label.lower() == "wiki" for label in labels), labels


@then("the footer does not link Product model to a GitHub blob")
def then_footer_product_model_is_not_github_blob(context: object) -> None:
    for label, href in _footer_links(context):
        if label == "Product model":
            assert GITHUB_BLOB_PATTERN.search(href) is None, href
            return
    raise AssertionError('Footer does not list "Product model"')


@then("the page states that the wiki is durable notes about agent workplaces")
def then_wiki_page_states_durable_notes_about_agent_workplaces(context: object) -> None:
    text = _visible_text(context).lower()
    assert "durable notes" in text, text
    assert "agent workplaces" in text, text


@then("the page describes general ideas")
def then_wiki_page_describes_general_ideas(context: object) -> None:
    text = _visible_text(context).lower()
    assert "general ideas" in text, text


@then("the page is marked noindex")
def then_page_is_marked_noindex(context: object) -> None:
    html = _html(context)
    assert ROBOTS_NOINDEX_PATTERN.search(html) is not None, html


@then("the page is not marked noindex")
def then_page_is_not_marked_noindex(context: object) -> None:
    html = _html(context)
    assert ROBOTS_NOINDEX_PATTERN.search(html) is None, html


@then("the article is a Markus document")
def then_article_is_a_markus_document(context: object) -> None:
    html = _html(context)
    assert MARKUS_DOCUMENT_PATTERN.search(html) is not None, html


@then("the article uses the Chatticus Markus theme")
def then_article_uses_chatticus_markus_theme(context: object) -> None:
    html = _html(context)
    assert CHATTICUS_THEME_PATTERN.search(html) is not None, html


@then("the page does not link to a GitHub blob of PRODUCT.md")
def then_page_does_not_link_to_github_blob_of_product_md(context: object) -> None:
    html = _html(context)
    for match in GITHUB_BLOB_PATTERN.finditer(html):
        assert "PRODUCT.md" not in match.group(0), match.group(0)
