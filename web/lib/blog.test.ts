import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  listPosts,
  parseFrontmatter,
  type BlogCategory,
} from "./blog";

const SAMPLE_POST = `---
title: First note
date: 2026-09-04
description: A short description.
ogHeadline: Headline for social
ogTagline: Tagline for social
draft: false
---
Hello from the desk.
`;

const OLDER_POST = `---
title: Older note
date: 2026-08-01
description: Earlier entry.
ogHeadline: Older headline
ogTagline: Older tagline
draft: false
---
Older body.
`;

const DRAFT_POST = `---
title: Draft note
date: 2026-09-05
description: Not published yet.
ogHeadline: Draft headline
ogTagline: Draft tagline
draft: true
---
Draft body.
`;

describe("parseFrontmatter", () => {
  it("parses required fields and body", () => {
    const parsed = parseFrontmatter(SAMPLE_POST);
    assert.equal(parsed.frontmatter.title, "First note");
    assert.equal(parsed.frontmatter.date, "2026-09-04");
    assert.equal(parsed.frontmatter.description, "A short description.");
    assert.equal(parsed.frontmatter.ogHeadline, "Headline for social");
    assert.equal(parsed.frontmatter.ogTagline, "Tagline for social");
    assert.equal(parsed.frontmatter.draft, false);
    assert.equal(parsed.body, "Hello from the desk.");
  });

  it("marks draft posts", () => {
    const parsed = parseFrontmatter(DRAFT_POST);
    assert.equal(parsed.frontmatter.draft, true);
  });

  it("parses optional relatedWiki slugs", () => {
    const withRelatedWiki = `${SAMPLE_POST.trimEnd()}\n`.replace(
      "draft: false",
      "draft: false\nrelatedWiki:\n  - reactor-chamber\n  - missing-page",
    );
    const parsed = parseFrontmatter(withRelatedWiki);
    assert.deepEqual(parsed.frontmatter.relatedWiki, ["reactor-chamber", "missing-page"]);
  });
});

describe("listPosts with a temporary content directory", () => {
  it("sorts newest first, filters by category, and excludes drafts", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatticus-blog-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(tempRoot);
      const updatesDir = path.join(tempRoot, "content", "blog", "updates");
      const agentZooDir = path.join(tempRoot, "content", "blog", "agent-zoo");
      fs.mkdirSync(updatesDir, { recursive: true });
      fs.mkdirSync(agentZooDir, { recursive: true });

      fs.writeFileSync(path.join(updatesDir, "older.md"), OLDER_POST);
      fs.writeFileSync(path.join(updatesDir, "newer.md"), SAMPLE_POST);
      fs.writeFileSync(path.join(updatesDir, "draft.md"), DRAFT_POST);
      fs.writeFileSync(path.join(agentZooDir, "peer.md"), SAMPLE_POST);
      fs.writeFileSync(path.join(updatesDir, ".gitkeep"), "");
      fs.writeFileSync(path.join(updatesDir, "notes.txt"), "skip me");

      const updatesPosts = listPosts("updates" as BlogCategory);
      assert.deepEqual(
        updatesPosts.map((post) => post.slug),
        ["newer", "older"],
      );

      const agentZooPosts = listPosts("agent-zoo" as BlogCategory);
      assert.deepEqual(
        agentZooPosts.map((post) => post.slug),
        ["peer"],
      );
      assert.equal(agentZooPosts[0]?.category, "agent-zoo");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("committed founding posts", () => {
  it("publishes the founding notes and skips drafts", () => {
    const updates = listPosts("updates");
    const zoo = listPosts("agent-zoo");

    assert.deepEqual(
      updates.map((post) => post.slug),
      ["the-workplace", "nothing-bills", "why-we-started"],
    );
    assert.deepEqual(
      zoo.map((post) => post.slug),
      ["nobody-agrees", "farms-and-desks"],
    );

    for (const post of [...updates, ...zoo]) {
      assert.equal(post.frontmatter.draft, false);
      assert.ok(post.frontmatter.ogHeadline);
      assert.ok(post.body.length > 0);
    }
  });
});
