import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { getPost } from "./blog";
import {
  getPage,
  listPages,
  parseFrontmatter,
  resolveRelatedPosts,
  resolveRelatedWiki,
  type WikiPage,
} from "./wiki";

const SAMPLE_PAGE = `---
title: Reactor chamber
description: A durable note about the category.
ogHeadline: Reactor chamber
ogTagline: One name for agent workplaces
draft: false
relatedPosts:
  - updates/first-week
  - agent-zoo/gastown
---
Body text.
`;

const DRAFT_PAGE = `---
title: Research note
description: Not published yet.
ogHeadline: Research
ogTagline: Draft
draft: true
---
Draft body.
`;

describe("parseFrontmatter", () => {
  it("parses required fields, body, and relatedPosts", () => {
    const parsed = parseFrontmatter(SAMPLE_PAGE);
    assert.equal(parsed.frontmatter.title, "Reactor chamber");
    assert.equal(parsed.frontmatter.description, "A durable note about the category.");
    assert.equal(parsed.frontmatter.ogHeadline, "Reactor chamber");
    assert.equal(parsed.frontmatter.ogTagline, "One name for agent workplaces");
    assert.equal(parsed.frontmatter.draft, false);
    assert.deepEqual(parsed.frontmatter.relatedPosts, ["updates/first-week", "agent-zoo/gastown"]);
    assert.equal(parsed.body, "Body text.");
  });

  it("marks draft pages", () => {
    const parsed = parseFrontmatter(DRAFT_PAGE);
    assert.equal(parsed.frontmatter.draft, true);
    assert.equal(parsed.frontmatter.relatedPosts, undefined);
  });
});

describe("listPages with a temporary content directory", () => {
  it("lists published pages alphabetically and excludes drafts", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatticus-wiki-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(tempRoot);
      const wikiDir = path.join(tempRoot, "content", "wiki");
      const blogUpdatesDir = path.join(tempRoot, "content", "blog", "updates");
      const blogAgentZooDir = path.join(tempRoot, "content", "blog", "agent-zoo");
      fs.mkdirSync(wikiDir, { recursive: true });
      fs.mkdirSync(blogUpdatesDir, { recursive: true });
      fs.mkdirSync(blogAgentZooDir, { recursive: true });

      fs.writeFileSync(path.join(wikiDir, "zebra.md"), SAMPLE_PAGE);
      fs.writeFileSync(path.join(wikiDir, "alpha.md"), SAMPLE_PAGE.replace("Reactor chamber", "Alpha"));
      fs.writeFileSync(path.join(wikiDir, "draft.md"), DRAFT_PAGE);
      fs.writeFileSync(path.join(wikiDir, ".gitkeep"), "");
      fs.writeFileSync(path.join(wikiDir, "notes.txt"), "skip me");

      const pages = listPages();
      assert.deepEqual(
        pages.map((page) => page.slug),
        ["alpha", "zebra"],
      );
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("resolveRelatedPosts", () => {
  it("omits missing or draft blog targets", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatticus-wiki-links-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(tempRoot);
      const wikiDir = path.join(tempRoot, "content", "wiki");
      const blogUpdatesDir = path.join(tempRoot, "content", "blog", "updates");
      const blogAgentZooDir = path.join(tempRoot, "content", "blog", "agent-zoo");
      fs.mkdirSync(wikiDir, { recursive: true });
      fs.mkdirSync(blogUpdatesDir, { recursive: true });
      fs.mkdirSync(blogAgentZooDir, { recursive: true });

      fs.writeFileSync(
        path.join(blogUpdatesDir, "first-week.md"),
        `---
title: First week
date: 2026-09-01
description: Published update.
ogHeadline: First week
ogTagline: Live
draft: false
---
Update body.`,
      );
      fs.writeFileSync(
        path.join(blogAgentZooDir, "draft-peer.md"),
        `---
title: Draft peer
date: 2026-09-02
description: Draft peer note.
ogHeadline: Draft peer
ogTagline: Draft
draft: true
---
Draft peer body.`,
      );
      fs.writeFileSync(
        path.join(wikiDir, "links.md"),
        `---
title: Links
description: Related posts.
ogHeadline: Links
ogTagline: Links
relatedPosts:
  - updates/first-week
  - updates/missing
  - agent-zoo/draft-peer
  - invalid
---
Body.`,
      );

      const page = getPage("links");
      assert.ok(page);

      const related = resolveRelatedPosts(page as WikiPage);
      assert.deepEqual(
        related.map((post) => `${post.category}/${post.slug}`),
        ["updates/first-week"],
      );
      assert.equal(getPost("updates", "missing"), null);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("resolveRelatedWiki", () => {
  it("omits missing or draft wiki targets", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatticus-blog-wiki-links-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(tempRoot);
      const wikiDir = path.join(tempRoot, "content", "wiki");
      const blogUpdatesDir = path.join(tempRoot, "content", "blog", "updates");
      fs.mkdirSync(wikiDir, { recursive: true });
      fs.mkdirSync(blogUpdatesDir, { recursive: true });

      fs.writeFileSync(
        path.join(wikiDir, "reactor-chamber.md"),
        `---
title: Reactor chamber
description: Published wiki page.
ogHeadline: Reactor chamber
ogTagline: Live
draft: false
---
Wiki body.`,
      );
      fs.writeFileSync(
        path.join(wikiDir, "draft-note.md"),
        `---
title: Draft note
description: Draft wiki page.
ogHeadline: Draft
ogTagline: Draft
draft: true
---
Draft wiki body.`,
      );
      fs.writeFileSync(
        path.join(blogUpdatesDir, "linked.md"),
        `---
title: Linked update
date: 2026-09-03
description: Links to wiki pages.
ogHeadline: Linked
ogTagline: Linked
relatedWiki:
  - reactor-chamber
  - missing-page
  - draft-note
---
Update body.`,
      );

      const post = getPost("updates", "linked");
      assert.ok(post);

      const related = resolveRelatedWiki(post as import("./blog").BlogPost);
      assert.deepEqual(
        related.map((page) => page.slug),
        ["reactor-chamber"],
      );
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
