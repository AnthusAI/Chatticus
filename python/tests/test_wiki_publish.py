"""Unit tests for Markus wiki publishing helpers."""

from __future__ import annotations

from pathlib import Path

from markusmd.render import default_css

from chatticus.wiki_publish import (
    FEATURED_PRODUCT_PAGES,
    add_heading_ids,
    apply_chatticus_theme,
    build_wiki_pages,
    default_idea_dir,
    markus_css_path,
    product_pages_for_repo,
    repo_root_from_here,
    rewrite_markdown_links,
    slug_lookup,
    write_generated_wiki,
)


def test_rewrite_relative_doc_link_to_wiki_slug(tmp_path: Path) -> None:
    repo = tmp_path
    source = repo / "docs" / "PRODUCT.md"
    source.parent.mkdir(parents=True)
    source.write_text("# Product\n", encoding="utf-8")
    slugs = {
        "docs/DESIGN_CHALLENGES.md": "design-challenges",
        "DESIGN_CHALLENGES.md": "design-challenges",
    }
    rewritten = rewrite_markdown_links(
        "See [Design challenges](DESIGN_CHALLENGES.md#the-cloud-api).",
        source_path=source,
        repo_root=repo,
        slugs=slugs,
    )
    assert (
        rewritten == "See [Design challenges](/wiki/design-challenges#the-cloud-api)."
    )


def test_rewrite_github_blob_to_wiki_slug(tmp_path: Path) -> None:
    repo = tmp_path
    source = repo / "web" / "content" / "wiki" / "note.md"
    source.parent.mkdir(parents=True)
    source.write_text("note", encoding="utf-8")
    slugs = {"docs/PRODUCT.md": "product", "PRODUCT.md": "product"}
    rewritten = rewrite_markdown_links(
        "The [product model](https://github.com/AnthusAI/Chattic.us/blob/develop/docs/PRODUCT.md).",
        source_path=source,
        repo_root=repo,
        slugs=slugs,
    )
    assert rewritten == "The [product model](/wiki/product)."


def test_rewrite_spike_path_to_github_blob(tmp_path: Path) -> None:
    repo = tmp_path
    (repo / "spikes" / "computer-cold-start" / "results").mkdir(parents=True)
    (repo / "spikes" / "computer-cold-start" / "results" / "README.md").write_text(
        "results\n", encoding="utf-8"
    )
    source = repo / "docs" / "DESIGN_CHALLENGES.md"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("# Design\n", encoding="utf-8")
    rewritten = rewrite_markdown_links(
        "See [results](../spikes/computer-cold-start/results/README.md).",
        source_path=source,
        repo_root=repo,
        slugs={},
    )
    assert rewritten == (
        "See [results](https://github.com/AnthusAI/Chattic.us/blob/develop/"
        "spikes/computer-cold-start/results/README.md)."
    )


def test_chatticus_theme_marks_markus_article() -> None:
    html = apply_chatticus_theme('<article class="markus-document"><p>Hi</p></article>')
    assert "markus-theme-chatticus" in html
    assert 'data-theme="chatticus"' in html


def test_heading_ids_match_github_slug() -> None:
    html = add_heading_ids("<h2>Approvals and takeover</h2>")
    assert 'id="approvals-and-takeover"' in html


def test_featured_product_slugs_cover_footer_docs() -> None:
    slugs = {page.slug for page in FEATURED_PRODUCT_PAGES}
    assert slugs >= {
        "product",
        "roadmap",
        "architecture",
        "design-challenges",
        "messaging",
        "computer-manifold",
        "cost-vs-sla",
        "license",
    }


def test_product_pages_do_not_publish_internal_briefs() -> None:
    pages = product_pages_for_repo(repo_root_from_here())
    slugs = {page.slug for page in pages}
    assert "feature-pages-brief" not in slugs
    assert "spec-coverage-baseline" not in slugs
    lookup = slug_lookup(pages)
    assert lookup["docs/COMPUTER_SNAPSHOTS.md"] == "computer-snapshots"


def test_committed_markus_css_matches_package() -> None:
    committed = markus_css_path().read_text(encoding="utf-8")
    assert committed == default_css()


def test_default_idea_dir_matches_build_wiki_pages_default(tmp_path: Path) -> None:
    assert default_idea_dir(tmp_path) == tmp_path / "web" / "content" / "wiki"


def test_build_wiki_pages_idea_dir_override_reads_ideas_from_elsewhere(
    tmp_path: Path,
) -> None:
    other_idea_dir = tmp_path / "elsewhere" / "ideas"
    other_idea_dir.mkdir(parents=True)
    (other_idea_dir / "override-idea.md").write_text(
        "---\n"
        "title: Override Idea\n"
        "description: Read from an overridden directory, not the repo's own.\n"
        "ogHeadline: Override Idea\n"
        "ogTagline: Not the repo's own idea dir\n"
        "---\n\n"
        "Body.\n",
        encoding="utf-8",
    )

    pages = build_wiki_pages(repo_root_from_here(), idea_dir=other_idea_dir)

    idea_slugs = {page["slug"] for page in pages if page["collection"] == "ideas"}
    assert idea_slugs == {"override-idea"}
    product_slugs = {page["slug"] for page in pages if page["collection"] == "product"}
    assert (
        "product" in product_slugs
    ), "docs/ still resolves from repo_root, not idea_dir"


def test_write_generated_wiki_output_dir_override_writes_elsewhere(
    tmp_path: Path,
) -> None:
    idea_dir = tmp_path / "ideas"
    idea_dir.mkdir()
    output_dir = tmp_path / "out"

    dest = write_generated_wiki(
        repo_root_from_here(), idea_dir=idea_dir, output_dir=output_dir
    )

    assert dest == output_dir / "pages.json"
    assert dest.is_file()
