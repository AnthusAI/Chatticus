"""Publish Chatticus wiki pages through Markus.

Idea notes live in ``web/content/wiki``. Product documentation lives in
``docs/`` and ``LICENSE``. This module converts both with Markus, rewrites
in-repo doc links to ``/wiki/{slug}``, and writes HTML fragments for the
Next.js wiki routes.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from html import unescape
from pathlib import Path

from markusmd import convert
from markusmd.render import default_css

GITHUB_BLOB_PREFIX = "https://github.com/AnthusAI/Chattic.us/blob/develop/"

SKIP_DOC_FILENAMES = frozenset(
    {
        "FEATURE_PAGES_BRIEF.md",
        "OPERATOR_ORG_SEED.md",
        "features-narrative-arc.md",
        "spec-coverage-baseline.md",
        "test-migration-survey.md",
    }
)

MARKDOWN_LINK_PATTERN = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
GITHUB_DOC_BLOB_PATTERN = re.compile(
    r"https://github\.com/AnthusAI/Chattic\.us/blob/(?:develop|main)/([^?#\s)]+)"
    r"(#[^)\s]*)?"
)
HEADING_PATTERN = re.compile(r"<h([1-6])([^>]*)>(.*?)</h\1>", re.IGNORECASE | re.DOTALL)
FRONTMATTER_PATTERN = re.compile(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$")
LEADING_H1_PATTERN = re.compile(r"^# [^\n]+\n+")


@dataclass(frozen=True)
class ProductWikiPage:
    """A product document published on the public wiki."""

    slug: str
    relative_path: str
    title: str
    description: str
    og_headline: str
    og_tagline: str
    listed: bool = True


FEATURED_PRODUCT_PAGES: tuple[ProductWikiPage, ...] = (
    ProductWikiPage(
        slug="product",
        relative_path="docs/PRODUCT.md",
        title="Product model",
        description=(
            "Named teammates, one shared computer, and human approval at "
            "the consequential edge."
        ),
        og_headline="Product model",
        og_tagline="Named teammates on one shared computer",
    ),
    ProductWikiPage(
        slug="roadmap",
        relative_path="docs/ROADMAP.md",
        title="Roadmap",
        description=(
            "The next slices of Chatticus: running software, not another "
            "architecture pass."
        ),
        og_headline="Roadmap",
        og_tagline="Running software, in this order",
    ),
    ProductWikiPage(
        slug="architecture",
        relative_path="docs/ARCHITECTURE.md",
        title="Architecture",
        description=(
            "A serverless control plane and a pull-based worker plane. "
            "v1 is one household."
        ),
        og_headline="Architecture",
        og_tagline="Control plane in AWS. Workers pull jobs.",
    ),
    ProductWikiPage(
        slug="design-challenges",
        relative_path="docs/DESIGN_CHALLENGES.md",
        title="Design challenges",
        description=(
            "Requirements, non-requirements, and the decisions that follow "
            "from them."
        ),
        og_headline="Design challenges",
        og_tagline="What must hold, and what must not.",
    ),
    ProductWikiPage(
        slug="messaging",
        relative_path="docs/MESSAGING.md",
        title="Messaging",
        description="The transcript and the one-turn stream. No persistent sockets.",
        og_headline="Messaging",
        og_tagline="One turn. Committed chunks. DynamoDB.",
    ),
    ProductWikiPage(
        slug="computer-manifold",
        relative_path="docs/COMPUTER_MANIFOLD.md",
        title="Computer manifold",
        description=(
            "Agents declare a kind of work, not a host. Snapshots are the "
            "contract between hosts."
        ),
        og_headline="Computer manifold",
        og_tagline="The workplace is an identity. Hosts are executors.",
    ),
    ProductWikiPage(
        slug="cost-vs-sla",
        relative_path="docs/COST_VS_SLA_TRADEOFF.md",
        title="Cost versus SLA",
        description=(
            "Persistent agents turn latency into schedulable slack. Same brain, "
            "more time."
        ),
        og_headline="Cost versus SLA",
        og_tagline="Do not replace the model. Give it more time.",
    ),
    ProductWikiPage(
        slug="license",
        relative_path="LICENSE",
        title="Free and Open-Source",
        description="Chatticus is MIT licensed. Read the license, then the source.",
        og_headline="Free and Open-Source",
        og_tagline="MIT licensed. Fork it. Run it.",
    ),
)


def repo_root_from_here() -> Path:
    """Return the Chatticus repository root containing ``docs/`` and ``web/``."""

    return Path(__file__).resolve().parents[3]


def generated_wiki_dir(repo_root: Path | None = None) -> Path:
    """Return the directory where Markus HTML fragments are written."""

    root = repo_root or repo_root_from_here()
    return root / "web" / "generated" / "wiki"


def default_idea_dir(repo_root: Path | None = None) -> Path:
    """Return the default directory of "ideas" collection wiki source markdown."""

    root = repo_root or repo_root_from_here()
    return root / "web" / "content" / "wiki"


def markus_css_path(repo_root: Path | None = None) -> Path:
    """Return the committed Markus base stylesheet path."""

    root = repo_root or repo_root_from_here()
    return root / "web" / "styles" / "markus.css"


def sync_markus_css(repo_root: Path | None = None) -> str:
    """Write Markus default CSS into the web styles directory and return it."""

    css = default_css()
    path = markus_css_path(repo_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(css, encoding="utf-8")
    return css


def slug_for_doc_filename(filename: str) -> str:
    """Return the wiki slug for a ``docs/*.md`` filename."""

    stem = filename.removesuffix(".md")
    return stem.lower().replace("_", "-")


def featured_slug_by_relative_path() -> dict[str, str]:
    """Map repository-relative doc paths to featured wiki slugs."""

    return {page.relative_path: page.slug for page in FEATURED_PRODUCT_PAGES}


def product_pages_for_repo(repo_root: Path) -> list[ProductWikiPage]:
    """Return featured product pages plus remaining public ``docs/*.md`` files."""

    pages = list(FEATURED_PRODUCT_PAGES)
    featured_paths = {page.relative_path for page in FEATURED_PRODUCT_PAGES}
    docs_dir = repo_root / "docs"
    for path in sorted(docs_dir.glob("*.md")):
        relative_path = f"docs/{path.name}"
        if path.name in SKIP_DOC_FILENAMES or relative_path in featured_paths:
            continue
        markdown = path.read_text(encoding="utf-8")
        title = _first_heading(markdown) or path.stem.replace("_", " ").title()
        description = _first_paragraph(markdown) or title
        pages.append(
            ProductWikiPage(
                slug=slug_for_doc_filename(path.name),
                relative_path=relative_path,
                title=title,
                description=description,
                og_headline=title,
                og_tagline=_tagline(description),
                listed=False,
            )
        )
    return pages


def slug_lookup(pages: list[ProductWikiPage]) -> dict[str, str]:
    """Map repository paths and basenames to wiki slugs."""

    lookup: dict[str, str] = {}
    for page in pages:
        lookup[page.relative_path] = page.slug
        lookup[Path(page.relative_path).name] = page.slug
    return lookup


def rewrite_markdown_links(
    markdown: str,
    *,
    source_path: Path,
    repo_root: Path,
    slugs: dict[str, str],
) -> str:
    """Rewrite in-repo documentation links to wiki routes."""

    def replace(match: re.Match[str]) -> str:
        text = match.group(1)
        target = match.group(2)
        rewritten = _rewrite_target(
            target,
            source_path=source_path,
            repo_root=repo_root,
            slugs=slugs,
        )
        return f"[{text}]({rewritten})"

    return MARKDOWN_LINK_PATTERN.sub(replace, markdown)


def apply_chatticus_theme(html: str) -> str:
    """Mark a Markus article as using the Chatticus theme."""

    themed = (
        '<article class="markus-document markus-theme-chatticus" '
        'data-theme="chatticus">'
    )
    return html.replace('<article class="markus-document">', themed, 1)


def add_heading_ids(html: str) -> str:
    """Add GitHub-style heading ids so fragment links keep working."""

    used: dict[str, int] = {}

    def replace(match: re.Match[str]) -> str:
        level = match.group(1)
        attrs = match.group(2)
        inner = match.group(3)
        if re.search(r"\sid=", attrs, re.IGNORECASE):
            return match.group(0)
        slug = _github_heading_id(inner)
        if slug in used:
            used[slug] += 1
            slug = f"{slug}-{used[slug]}"
        else:
            used[slug] = 0
        return f'<h{level}{attrs} id="{slug}">{inner}</h{level}>'

    return HEADING_PATTERN.sub(replace, html)


def render_markus_article(
    markdown: str,
    *,
    source_path: Path,
    repo_root: Path,
    slugs: dict[str, str],
    strip_leading_heading: bool = False,
) -> str:
    """Convert one wiki source to a themed Markus HTML fragment."""

    body = markdown
    if strip_leading_heading:
        body = LEADING_H1_PATTERN.sub("", body, count=1)
    body = rewrite_markdown_links(
        body,
        source_path=source_path,
        repo_root=repo_root,
        slugs=slugs,
    )
    html = convert(body, include_css=False, full_document=False)
    return add_heading_ids(apply_chatticus_theme(html))


def parse_idea_frontmatter(raw: str) -> dict[str, object]:
    """Parse YAML frontmatter from an idea wiki page."""

    match = FRONTMATTER_PATTERN.match(raw)
    if not match:
        raise ValueError("Wiki page is missing YAML frontmatter delimiters")
    yaml_block, body = match.group(1), match.group(2)
    fields: dict[str, object] = {}
    lines = yaml_block.splitlines()
    index = 0
    while index < len(lines):
        trimmed = lines[index].strip()
        if not trimmed:
            index += 1
            continue
        separator = trimmed.find(":")
        if separator == -1:
            index += 1
            continue
        key = trimmed[:separator].strip()
        inline = trimmed[separator + 1 :].strip()
        if not inline and key in {"relatedPosts", "relatedWiki"}:
            items, index = _parse_yaml_list(lines, index)
            fields[key] = items
            continue
        value: object = _unquote(inline)
        if value == "true":
            value = True
        elif value == "false":
            value = False
        fields[key] = value
        index += 1
    fields["body"] = body.strip()
    return fields


def build_wiki_pages(
    repo_root: Path | None = None,
    *,
    idea_dir: Path | None = None,
) -> list[dict[str, object]]:
    """Build the published wiki catalog as JSON-ready dictionaries.

    ``idea_dir`` overrides where "ideas" collection markdown is read from,
    independent of ``repo_root`` (which still locates ``docs/`` and
    ``LICENSE`` for the "product" collection). A downstream repo that
    depends on this one as a package -- see the private marketing/SaaS
    repo -- keeps its own idea essays out of this open-source tree while
    still generating the product-doc pages from this repo's ``docs/``.
    """

    root = repo_root or repo_root_from_here()
    product_pages = product_pages_for_repo(root)
    slugs = slug_lookup(product_pages)
    published: list[dict[str, object]] = []

    resolved_idea_dir = idea_dir or default_idea_dir(root)
    for path in sorted(resolved_idea_dir.glob("*.md")):
        if path.name == "AGENTS.md":
            continue
        parsed = parse_idea_frontmatter(path.read_text(encoding="utf-8"))
        if parsed.get("draft") is True:
            continue
        html = render_markus_article(
            str(parsed["body"]),
            source_path=path,
            repo_root=root,
            slugs=slugs,
        )
        published.append(
            {
                "slug": path.stem,
                "collection": "ideas",
                "listed": True,
                "frontmatter": {
                    "title": parsed["title"],
                    "description": parsed["description"],
                    "ogHeadline": parsed["ogHeadline"],
                    "ogTagline": parsed["ogTagline"],
                    "draft": False,
                    "relatedPosts": parsed.get("relatedPosts"),
                },
                "html": html,
            }
        )

    for page in product_pages:
        source_path = root / page.relative_path
        markdown = source_path.read_text(encoding="utf-8")
        html = render_markus_article(
            markdown,
            source_path=source_path,
            repo_root=root,
            slugs=slugs,
            strip_leading_heading=page.relative_path != "LICENSE",
        )
        published.append(
            {
                "slug": page.slug,
                "collection": "product",
                "listed": page.listed,
                "frontmatter": {
                    "title": page.title,
                    "description": page.description,
                    "ogHeadline": page.og_headline,
                    "ogTagline": page.og_tagline,
                    "draft": False,
                },
                "html": html,
            }
        )
    return published


def write_generated_wiki(
    repo_root: Path | None = None,
    *,
    idea_dir: Path | None = None,
    output_dir: Path | None = None,
) -> Path:
    """Write Markus HTML fragments and return the pages.json path.

    ``idea_dir`` and ``output_dir`` default to this repo's own layout
    (``web/content/wiki`` and ``web/generated/wiki``) but can each be
    overridden independently -- see ``build_wiki_pages`` for why a
    downstream repo wants its own idea source directory, and a downstream
    repo without a nested ``web/`` (the marketing/SaaS app is its own repo
    root, not a monorepo subdirectory) wants its own output directory too.
    """

    root = repo_root or repo_root_from_here()
    sync_markus_css(root)
    dest_dir = output_dir or generated_wiki_dir(root)
    dest_dir.mkdir(parents=True, exist_ok=True)
    pages = build_wiki_pages(root, idea_dir=idea_dir)
    dest = dest_dir / "pages.json"
    dest.write_text(json.dumps({"pages": pages}, indent=2) + "\n", encoding="utf-8")
    return dest


def _rewrite_target(
    target: str,
    *,
    source_path: Path,
    repo_root: Path,
    slugs: dict[str, str],
) -> str:
    blob_match = GITHUB_DOC_BLOB_PATTERN.fullmatch(target.strip())
    if blob_match:
        relative = blob_match.group(1)
        anchor = blob_match.group(2) or ""
        slug = slugs.get(relative) or slugs.get(Path(relative).name)
        if slug:
            return f"/wiki/{slug}{anchor}"
        return target

    if target.startswith(("http://", "https://", "mailto:", "#", "/")):
        return target

    href, anchor = _split_anchor(target)
    if not href:
        return target
    resolved = (source_path.parent / href).resolve()
    try:
        relative_path = resolved.relative_to(repo_root).as_posix()
    except ValueError:
        return target
    slug = slugs.get(relative_path) or slugs.get(Path(relative_path).name)
    if slug:
        return f"/wiki/{slug}{anchor}"
    return f"{GITHUB_BLOB_PREFIX}{relative_path}{anchor}"


def _split_anchor(target: str) -> tuple[str, str]:
    if "#" in target:
        href, anchor = target.split("#", 1)
        return href, f"#{anchor}"
    return target, ""


def _github_heading_id(inner_html: str) -> str:
    text = unescape(re.sub(r"<[^>]+>", "", inner_html)).strip().lower()
    text = re.sub(r"[^\w\s-]", "", text, flags=re.UNICODE)
    text = re.sub(r"[-\s]+", "-", text).strip("-")
    return text


def _first_heading(markdown: str) -> str:
    for line in markdown.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return ""


def _first_paragraph(markdown: str) -> str:
    paragraphs: list[str] = []
    current: list[str] = []
    for line in markdown.splitlines():
        stripped = line.strip()
        if (
            stripped.startswith("#")
            or stripped.startswith("|")
            or stripped.startswith("```")
        ):
            if current:
                break
            continue
        if not stripped:
            if current:
                break
            continue
        current.append(stripped)
    if current:
        paragraphs.append(" ".join(current))
    if not paragraphs:
        return ""
    text = paragraphs[0]
    if len(text) > 220:
        return text[:217].rstrip() + "..."
    return text


def _tagline(description: str) -> str:
    sentence = description.split(". ")[0].rstrip(".")
    if len(sentence) > 80:
        return sentence[:77].rstrip() + "..."
    return sentence


def _parse_yaml_list(lines: list[str], start_index: int) -> tuple[list[str], int]:
    items: list[str] = []
    index = start_index + 1
    while index < len(lines):
        trimmed = lines[index].strip()
        if not trimmed:
            index += 1
            continue
        if not trimmed.startswith("- "):
            break
        items.append(_unquote(trimmed[2:].strip()))
        index += 1
    return items, index


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def main() -> None:
    """Write generated wiki HTML for the Next.js build.

    ``--idea-dir`` and ``--output-dir`` let a downstream repo (the private
    marketing/SaaS repo, running this against its ``chatticus`` tarball
    dependency) generate its own wiki without a nested ``web/`` layout or
    this repo's own idea essays -- see ``write_generated_wiki``.
    """

    parser = argparse.ArgumentParser(description=main.__doc__)
    parser.add_argument(
        "--idea-dir",
        type=Path,
        default=None,
        help="Override the 'ideas' collection markdown source directory.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Override the directory pages.json is written into.",
    )
    args = parser.parse_args()
    dest = write_generated_wiki(idea_dir=args.idea_dir, output_dir=args.output_dir)
    print(dest)


if __name__ == "__main__":
    main()
