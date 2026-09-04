"""Behave steps for marketing footer Build links."""

from __future__ import annotations

import re

from behave import then
from marketing_blog_steps import FOOTER_LINK_PATTERN, _footer_html

LICENSE_HREF_PATTERN = re.compile(r"/wiki/license(?:$|[?#])", re.IGNORECASE)


def _footer_links(context: object) -> list[tuple[str, str]]:
    footer_html = _footer_html(context)
    links: list[tuple[str, str]] = []
    for link_match in FOOTER_LINK_PATTERN.finditer(footer_html):
        href = link_match.group(1)
        label = re.sub(r"<[^>]+>", "", link_match.group(2))
        label = " ".join(label.split())
        links.append((label, href))
    return links


@then("the footer lists Free and Open-Source linking to the license")
def then_footer_lists_free_and_open_source(context: object) -> None:
    for label, href in _footer_links(context):
        if label == "Free and Open-Source":
            assert LICENSE_HREF_PATTERN.search(
                href
            ), f"Free and Open-Source href is not the license: {href!r}"
            return
    raise AssertionError('Footer does not list "Free and Open-Source"')


@then("the footer does not list Vultus avatars")
def then_footer_does_not_list_vultus_avatars(context: object) -> None:
    labels = [label.lower() for label, _href in _footer_links(context)]
    assert "vultus avatars" not in labels, labels


@then("the footer does not list Anth.us")
def then_footer_does_not_list_anthus(context: object) -> None:
    labels = [label.lower() for label, _href in _footer_links(context)]
    assert "anth.us" not in labels, labels
    hrefs = [href.lower() for _label, href in _footer_links(context)]
    assert not any("anth.us" in href for href in hrefs), hrefs
