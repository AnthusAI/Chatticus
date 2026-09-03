"""Behave steps for marketing primary navigation section links."""

from __future__ import annotations

import re

from behave import then

PRIMARY_NAV_PATTERN = re.compile(
    r'<nav[^>]*aria-label="Primary navigation"[^>]*>(.*?)</nav>',
    re.DOTALL | re.IGNORECASE,
)


def _primary_nav_html(context: object) -> str:
    html = context.marketing_ui_harness.get("html") or ""
    match = PRIMARY_NAV_PATTERN.search(html)
    assert match is not None, "Primary navigation not found in rendered HTML"
    return match.group(1)


def _anchor_href_for_aria_label(nav_html: str, aria_label: str) -> str:
    pattern = re.compile(
        rf'<a\b[^>]*aria-label="{re.escape(aria_label)}"[^>]*href="([^"]+)"',
        re.IGNORECASE,
    )
    match = pattern.search(nav_html)
    if match is None:
        pattern = re.compile(
            rf'<a\b[^>]*href="([^"]+)"[^>]*aria-label="{re.escape(aria_label)}"',
            re.IGNORECASE,
        )
        match = pattern.search(nav_html)
    assert match is not None, f'Link with aria-label "{aria_label}" not found'
    return match.group(1)


def _anchor_href_for_link_text(nav_html: str, link_text: str) -> str:
    pattern = re.compile(
        rf'<a\b[^>]*href="([^"]+)"[^>]*>\s*{re.escape(link_text)}\s*</a>',
        re.IGNORECASE,
    )
    match = pattern.search(nav_html)
    assert match is not None, f'Link "{link_text}" not found in primary navigation'
    return match.group(1)


def _assert_primary_nav_href(
    context: object,
    *,
    link_text: str | None,
    aria_label: str | None,
    expected_href: str,
) -> None:
    nav_html = _primary_nav_html(context)
    if aria_label is not None:
        href = _anchor_href_for_aria_label(nav_html, aria_label)
    else:
        assert link_text is not None
        href = _anchor_href_for_link_text(nav_html, link_text)
    assert href == expected_href, f"expected {expected_href!r}, got {href!r}"


@then("the Chatticus home link in the primary navigation goes to the home page top")
def then_chatticus_home_link_goes_to_home_top(context: object) -> None:
    _assert_primary_nav_href(
        context,
        link_text=None,
        aria_label="Chatticus home",
        expected_href="/#top",
    )


@then(
    "the Organization link in the primary navigation goes to the home page Organization section"  # noqa: E501
)
def then_organization_link_goes_to_home_section(context: object) -> None:
    _assert_primary_nav_href(
        context,
        link_text="Organization",
        aria_label=None,
        expected_href="/#organization",
    )


@then(
    "the Why Chatticus link in the primary navigation goes to the home page Why Chatticus section"  # noqa: E501
)
def then_why_chatticus_link_goes_to_home_section(context: object) -> None:
    _assert_primary_nav_href(
        context,
        link_text="Why Chatticus",
        aria_label=None,
        expected_href="/#control",
    )


@then(
    "the Evidence link in the primary navigation goes to the home page Evidence section"
)
def then_evidence_link_goes_to_home_section(context: object) -> None:
    _assert_primary_nav_href(
        context,
        link_text="Evidence",
        aria_label=None,
        expected_href="/#evidence",
    )


@then("the FAQ link in the primary navigation goes to the home page FAQ section")
def then_faq_link_goes_to_home_section(context: object) -> None:
    _assert_primary_nav_href(
        context,
        link_text="FAQ",
        aria_label=None,
        expected_href="/#faq",
    )


@then("the home page has sections for Organization, Why Chatticus, Evidence, and FAQ")
def then_home_page_has_section_ids(context: object) -> None:
    html = context.marketing_ui_harness.get("html") or ""
    for section_id in ("organization", "control", "evidence", "faq"):
        assert f'id="{section_id}"' in html, f'missing home section id="{section_id}"'
