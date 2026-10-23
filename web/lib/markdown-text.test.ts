import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { safeLinkTarget } from "./markdown-safety";

(globalThis as { React?: typeof React }).React = React;
type MarkdownModule = typeof import("../../chat/react/MarkdownText");
let MarkdownText: MarkdownModule["MarkdownText"];

before(async () => {
  ({ MarkdownText } = await import("../../chat/react/MarkdownText"));
});

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownText, { text }));
}

describe("safeLinkTarget", () => {
  it("allows http, https and mailto only", () => {
    assert.equal(safeLinkTarget("https://example.com/a?b=1"), "https://example.com/a?b=1");
    assert.equal(safeLinkTarget("http://example.com"), "http://example.com");
    assert.equal(safeLinkTarget("mailto:hi@example.com"), "mailto:hi@example.com");
  });

  it("refuses scripts, data, relative and empty targets", () => {
    assert.equal(safeLinkTarget("javascript:alert(1)"), null);
    assert.equal(safeLinkTarget(" JaVaScRiPt:alert(1)"), null);
    assert.equal(safeLinkTarget("data:text/html,<b>x</b>"), null);
    assert.equal(safeLinkTarget("/relative"), null);
    assert.equal(safeLinkTarget(""), null);
    assert.equal(safeLinkTarget(undefined), null);
  });
});

describe("MarkdownText", () => {
  it("renders a fenced code block with language, copy button and scrolling", () => {
    const html = render("Here:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n");
    assert.match(html, /data-testid="markdown-code-block"/);
    assert.match(html, /const a = 1;\nconst b = 2;/);
    assert.match(html, />ts</);
    assert.match(html, /<button[^>]*type="button"[^>]*aria-label="Copy code"/);
    assert.match(html, /overflow-x-auto/);
    assert.doesNotMatch(html, /```/);
  });

  it("renders an unclosed fence from a streaming reply as an open code block", () => {
    const html = render("Run this:\n\n```bash\nnpm install\nnpm te");
    assert.match(html, /data-testid="markdown-code-block"/);
    assert.match(html, /npm install\nnpm te/);
    assert.doesNotMatch(html, /```/);
  });

  it("renders the same block before and after the closing fence arrives", () => {
    const open = render("```js\nlet x = 1;");
    const closed = render("```js\nlet x = 1;\n```");
    assert.equal(open, closed);
  });

  it("renders inline code, bold and italic", () => {
    const html = render("Use `npm test` for **all** the *checks*.");
    assert.match(html, /<code[^>]*>npm test<\/code>/);
    assert.match(html, /<strong[^>]*>all<\/strong>/);
    assert.match(html, /<em[^>]*>checks<\/em>/);
  });

  it("renders ordered and unordered lists", () => {
    const html = render("- one\n- two\n\n1. first\n2. second\n");
    assert.match(html, /<ul[^>]*>/);
    assert.match(html, /<ol[^>]*>/);
    assert.equal(html.match(/<li/g)?.length, 4);
  });

  it("maps headings, blockquotes and paragraphs", () => {
    const html = render("# Big\n\n### Small\n\n> quoted\n\nplain");
    assert.match(html, /<h1[^>]*>Big<\/h1>/);
    assert.match(html, /<h3[^>]*>Small<\/h3>/);
    assert.match(html, /<blockquote/);
    assert.match(html, /<p[^>]*>plain<\/p>/);
  });

  it("opens http links in a new tab without opener access", () => {
    const html = render("[docs](https://example.com/docs)");
    assert.match(html, /href="https:\/\/example.com\/docs"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
  });

  it("does not link javascript: urls", () => {
    const html = render("[click](javascript:alert(1)) and [also](data:text/html;base64,AAAA)");
    assert.doesNotMatch(html, /<a[ >]/);
    assert.doesNotMatch(html, /javascript:/);
    assert.match(html, /click/);
  });

  it("escapes raw html instead of rendering it", () => {
    const html = render('<script>alert(1)</script> <img src=x onerror=alert(1)> <b>bold?</b>');
    assert.doesNotMatch(html, /<script/);
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /<b>/);
    assert.match(html, /&lt;script&gt;/);
  });

  it("shows an image as a plain text link", () => {
    const html = render("![a cat](https://example.com/cat.png)");
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /<a [^>]*href="https:\/\/example.com\/cat.png"[^>]*>a cat<\/a>/);
  });

  it("keeps single line breaks inside a paragraph", () => {
    assert.match(render("line one\nline two"), /whitespace-pre-wrap/);
  });

  it("uses no borders or outlines on its regions", () => {
    const html = render("> q\n\n```\ncode\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    assert.doesNotMatch(html, /(?:^|[\s"])border(?:-|\s|")/);
    assert.doesNotMatch(html, /divide-/);
  });
});
