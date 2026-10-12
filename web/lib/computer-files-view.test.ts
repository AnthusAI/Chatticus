import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { buildListingView, describeFilesError, FilesApiError } from "./computer-files";
import { emptyListing, textFileRange, touchingCards, workspaceListing } from "./computer-files-fixtures";
import { INSPECTOR_TABS, nextInspectorTab } from "./inspector-tabs";
import { collectTouchedFiles } from "./touched-files";

(globalThis as { React?: typeof React }).React = React;
type View = typeof import("../components/workspace/ComputerFilesView");
type Tabs = typeof import("../components/workspace/InspectorTabs");
let view: View;
let tabs: Tabs;

before(async () => {
  view = await import("../components/workspace/ComputerFilesView");
  tabs = await import("../components/workspace/InspectorTabs");
});

const noop = () => undefined;

describe("FilesBreadcrumb", () => {
  it("is a nav landmark with earlier segments as buttons and the last as current", () => {
    const html = renderToStaticMarkup(createElement(view.FilesBreadcrumb, { path: "/workspace/src", onNavigate: noop }));
    assert.match(html, /<nav aria-label="File path">/);
    assert.match(html, /<button[^>]*>workspace<\/button>/);
    assert.match(html, /aria-current="page"[^>]*>src</);
  });
});

describe("FilesListing", () => {
  it("lists rows as buttons with kind in text and link targets", () => {
    const html = renderToStaticMarkup(
      createElement(view.FilesListing, { view: buildListingView(workspaceListing), onOpenDirectory: noop, onOpenFile: noop }),
    );
    assert.match(html, /aria-label="Folder docs"/);
    assert.match(html, /aria-label="File notes.txt, 412 B"/);
    assert.match(html, /links to \/workspace\/src\/index.ts/);
    assert.ok(html.indexOf("docs/") < html.indexOf("notes.txt"));
    assert.doesNotMatch(html, /border|outline-(?!none)/);
  });

  it("says plainly when a folder is empty", () => {
    const html = renderToStaticMarkup(
      createElement(view.FilesListing, { view: buildListingView(emptyListing), onOpenDirectory: noop, onOpenFile: noop }),
    );
    assert.match(html, /This folder is empty/);
  });
});

describe("notices", () => {
  it("shows the no-snapshot empty state with a retry", () => {
    const html = renderToStaticMarkup(
      createElement(view.FilesNotice, { view: describeFilesError(new FilesApiError(404, "no_snapshot", "")), onRetry: noop }),
    );
    assert.match(html, /This organization&#x27;s computer has no saved files yet/);
    assert.match(html, /role="status"/);
    assert.match(html, /Try again/);
  });

  it("uses an alert for real errors and omits retry when it cannot help", () => {
    const html = renderToStaticMarkup(
      createElement(view.FilesNotice, { view: describeFilesError(new FilesApiError(400, "invalid_path", "")), onRetry: noop }),
    );
    assert.match(html, /role="alert"/);
    assert.doesNotMatch(html, /Try again/);
  });

  it("states that the copy is saved, not live", () => {
    const html = renderToStaticMarkup(createElement(view.SavedCopyNote, { asOfText: "Saved 5 minutes ago" }));
    assert.match(html, /Showing the last saved copy of the computer/);
    assert.match(html, /Saved 5 minutes ago/);
  });
});

describe("TouchedFilesList", () => {
  it("lists paths with text marks and accessible names", () => {
    const html = renderToStaticMarkup(
      createElement(view.TouchedFilesList, { files: collectTouchedFiles(touchingCards), onOpen: noop }),
    );
    assert.match(html, /Files Pi touched/);
    assert.match(html, /aria-label="Wrote \/workspace\/src\/index.ts"/);
    assert.match(html, /aria-label="Edited \/workspace\/notes.txt"/);
  });

  it("has a plain empty state", () => {
    const html = renderToStaticMarkup(createElement(view.TouchedFilesList, { files: [], onOpen: noop }));
    assert.match(html, /No files read or changed in recent turns/);
  });
});

describe("FileViewer", () => {
  const base = {
    name: "notes.txt",
    size: 262144 * 2,
    sha256: "a".repeat(64),
    hasMore: false,
    loadingMore: false,
    loadedBytes: 262144,
    copied: false,
    onLoadMore: noop,
    onCopy: noop,
  };

  it("escapes text, never rendering it as HTML, and offers an accessibly named copy", () => {
    const html = renderToStaticMarkup(
      createElement(view.FileViewer, { ...base, body: { kind: "text", text: textFileRange.content } }),
    );
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /<pre[^>]*tabindex="0"[^>]*aria-label="Contents of notes.txt"/);
    assert.match(html, /aria-label="Copy text of notes.txt"/);
    assert.match(html, /title="a{64}"[^>]*>sha256 a{12}</);
    assert.doesNotMatch(html, /contenteditable|<textarea|<input/i);
  });

  it("offers Load more with progress for a file larger than one range", () => {
    const html = renderToStaticMarkup(
      createElement(view.FileViewer, { ...base, hasMore: true, body: { kind: "text", text: "x" } }),
    );
    assert.match(html, /Load more/);
    assert.match(html, /Showing 256 KiB of 512 KiB/);
    assert.match(html, /aria-label="Copy loaded text of notes.txt"/);
  });

  it("shows the masked message with no content", () => {
    const html = renderToStaticMarkup(createElement(view.FileViewer, { ...base, body: { kind: "masked" } }));
    assert.match(html, /This file looks like it holds a secret and is not shown\./);
    assert.doesNotMatch(html, /<pre/);
  });

  it("shows binary files with no preview", () => {
    const html = renderToStaticMarkup(createElement(view.FileViewer, { ...base, body: { kind: "binary", size: 9000 } }));
    assert.match(html, /Binary file, 9000 bytes/);
    assert.doesNotMatch(html, /<img/);
  });

  it("shows an image from its blob URL with alternative text", () => {
    const html = renderToStaticMarkup(
      createElement(view.FileViewer, { ...base, name: "logo.png", body: { kind: "image", url: "blob:x", mime: "image/png" } }),
    );
    assert.match(html, /<img src="blob:x" alt="Preview of logo.png"/);
  });
});

describe("InspectorTabs", () => {
  it("is a tablist with the selected tab focusable", () => {
    const html = renderToStaticMarkup(createElement(tabs.InspectorTabs, { selected: "files", onSelect: noop }));
    assert.match(html, /role="tablist"/);
    assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"[^>]*>Files/);
    assert.match(html, /aria-selected="false"[^>]*tabindex="-1"[^>]*>Context/);
  });

  it("moves between tabs with arrow, Home and End keys", () => {
    assert.equal(nextInspectorTab("context", "ArrowRight"), "files");
    assert.equal(nextInspectorTab("files", "ArrowRight"), "context");
    assert.equal(nextInspectorTab("context", "ArrowLeft"), "files");
    assert.equal(nextInspectorTab("files", "Home"), INSPECTOR_TABS[0].id);
    assert.equal(nextInspectorTab("context", "End"), "files");
    assert.equal(nextInspectorTab("context", "a"), null);
  });
});
