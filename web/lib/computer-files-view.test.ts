import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { buildListingView, describeFilesError, FilesApiError } from "./computer-files";
import { emptyListing, textFileRange, touchingCards, workspaceListing } from "./computer-files-fixtures";
import { startEditSession } from "./computer-files-edit";
import { CORE_PANEL_PLUGINS, nextPanelPlugin, panelSizeForPlugin, workspaceShellLayoutClassName } from "./panel-plugins";
import { collectTouchedFiles } from "./touched-files";

(globalThis as { React?: typeof React }).React = React;
type View = typeof import("../components/workspace/ComputerFilesView");
type Tabs = typeof import("../components/workspace/PanelPluginTabs");
let view: View;
let tabs: Tabs;

before(async () => {
  view = await import("../components/workspace/ComputerFilesView");
  tabs = await import("../components/workspace/PanelPluginTabs");
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

  it("says where the files come from in a polite live region, with a Retry only for a fallback", () => {
    const saved = renderToStaticMarkup(
      createElement(view.SourceLineView, { line: { text: "Computer is off. Showing the copy saved 5 minutes ago", tone: "saved", retryable: false }, onRetry: noop }),
    );
    assert.match(saved, /aria-live="polite"/);
    assert.match(saved, /Computer is off. Showing the copy saved 5 minutes ago/);
    assert.doesNotMatch(saved, /Retry/);
    const trouble = renderToStaticMarkup(
      createElement(view.SourceLineView, { line: { text: "Could not reach the running computer. Showing the saved copy", tone: "trouble", retryable: true }, onRetry: noop }),
    );
    assert.match(trouble, />Retry</);
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

describe("PanelPluginTabs", () => {
  it("is a tablist with the selected tab focusable", () => {
    const html = renderToStaticMarkup(createElement(tabs.PanelPluginTabs, { selected: "files", onSelect: noop }));
    assert.match(html, /role="tablist"/);
    assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"[^>]*>Files/);
    assert.match(html, /aria-selected="false"[^>]*tabindex="-1"[^>]*>Context/);
  });

  it("moves between tabs with arrow, Home and End keys", () => {
    assert.equal(nextPanelPlugin("context", "ArrowRight"), "files");
    assert.equal(nextPanelPlugin("files", "ArrowRight"), "costs");
    assert.equal(nextPanelPlugin("costs", "ArrowRight"), "context");
    assert.equal(nextPanelPlugin("context", "ArrowLeft"), "costs");
    assert.equal(nextPanelPlugin("files", "Home"), CORE_PANEL_PLUGINS[0].id);
    assert.equal(nextPanelPlugin("context", "End"), "costs");
    assert.equal(nextPanelPlugin("context", "a"), null);
  });

  it("opens a plugin at the requested size when the plugin supports it", () => {
    assert.equal(panelSizeForPlugin("files", "full"), "full");
    assert.equal(panelSizeForPlugin("costs", "split"), "split");
  });

  it("names the shell layout for a collapsed, split and full panel", () => {
    assert.equal(workspaceShellLayoutClassName({ collapsed: true, size: "full" }), "workspace-shell workspace-shell--panel-collapsed");
    assert.equal(workspaceShellLayoutClassName({ collapsed: false, size: "split" }), "workspace-shell");
    assert.equal(workspaceShellLayoutClassName({ collapsed: false, size: "full" }), "workspace-shell workspace-shell--panel-full");
  });

  it("switches the panel between split and full", () => {
    const html = renderToStaticMarkup(createElement(tabs.PanelSizeSwitch, { size: "full", onChange: noop }));
    assert.match(html, /role="group" aria-label="Panel size"/);
    assert.match(html, /aria-pressed="true"[^>]*>Full/);
    assert.match(html, /aria-pressed="false"[^>]*>Split/);
  });
});

describe("change controls", () => {
  const live = { ...textFileRange, source: "live" as const };

  it("marks a row that waits for the computer and offers Rename and Delete by name", () => {
    const html = renderToStaticMarkup(
      createElement(view.FilesListing, {
        view: buildListingView(workspaceListing),
        onOpenDirectory: noop,
        onOpenFile: noop,
        marks: { "/workspace/notes.txt": "Edited, waiting for the computer" },
        actions: { onRename: noop, onDelete: noop },
      }),
    );
    assert.match(html, /aria-label="File notes.txt, 412 B, Edited, waiting for the computer"/);
    assert.match(html, /aria-label="Rename notes.txt"/);
    assert.match(html, /aria-label="Delete src"/);
  });

  it("offers no change buttons without actions", () => {
    const html = renderToStaticMarkup(
      createElement(view.FilesListing, { view: buildListingView(workspaceListing), onOpenDirectory: noop, onOpenFile: noop }),
    );
    assert.doesNotMatch(html, /Rename|Delete/);
  });

  it("shows Edit only when offered, and Reveal for a masked file, Hide for a revealed one", () => {
    const base = { name: "notes.txt", size: 10, sha256: "a".repeat(64), hasMore: false, loadingMore: false, loadedBytes: 10, copied: false, onLoadMore: noop, onCopy: noop };
    const withEdit = renderToStaticMarkup(createElement(view.FileViewer, { ...base, body: { kind: "text", text: "x" }, canEdit: true, onEdit: noop }));
    assert.match(withEdit, /aria-label="Edit notes.txt"/);
    const tooLarge = renderToStaticMarkup(createElement(view.FileViewer, { ...base, body: { kind: "text", text: "x" }, tooLargeToEdit: true }));
    assert.match(tooLarge, /This file is too large to edit here/);
    assert.doesNotMatch(tooLarge, /aria-label="Edit/);
    const masked = renderToStaticMarkup(createElement(view.FileViewer, { ...base, body: { kind: "masked" }, onReveal: noop }));
    assert.match(masked, />Reveal</);
    const revealed = renderToStaticMarkup(createElement(view.FileViewer, { ...base, body: { kind: "text", text: "S" }, revealed: true, onHide: noop }));
    assert.match(revealed, />Hide</);
  });

  it("renders the editor with a labelled text area, Save, and the Pi notice only when Pi changed the file", () => {
    const session = startEditSession(live);
    const props = { name: "notes.txt", blockedReason: null, onChange: noop, onSave: noop, onRetry: noop, onReload: noop, onShowTheirs: noop };
    const plain = renderToStaticMarkup(createElement(view.FileEditor, { ...props, session }));
    assert.match(plain, /<label[^>]*for="computer-file-editor"[^>]*>Editing notes.txt<\/label>/);
    assert.match(plain, /<textarea[^>]*id="computer-file-editor"/);
    assert.doesNotMatch(plain, /Pi changed this a moment ago/);
    const changed = renderToStaticMarkup(createElement(view.FileEditor, { ...props, session: { ...session, piChanged: true } }));
    assert.match(changed, /Pi changed this a moment ago/);
    assert.match(changed, /Show their version/);
    const saving = renderToStaticMarkup(createElement(view.FileEditor, { ...props, session: { ...session, phase: "saving" }, blockedReason: "Saving" }));
    assert.match(saving, /disabled=""/);
  });

  it("says a kept draft in words, with Retry or Reload", () => {
    const session = startEditSession(live);
    const retry = renderToStaticMarkup(
      createElement(view.FileEditor, {
        name: "n",
        session: { ...session, notice: { kind: "error", code: "owner_timeout", attempt: 1, view: describeFilesError(new FilesApiError(504, "owner_timeout", "")) } },
        blockedReason: null,
        onChange: noop,
        onSave: noop,
        onRetry: noop,
        onReload: noop,
        onShowTheirs: noop,
      }),
    );
    assert.match(retry, /Could not reach the computer; your text is kept/);
    assert.match(retry, />Retry</);
    const reload = renderToStaticMarkup(
      createElement(view.FileEditor, {
        name: "n",
        session: { ...session, notice: { kind: "error", code: "outcome_unknown", attempt: 1, view: describeFilesError(new FilesApiError(504, "outcome_unknown", "")) } },
        blockedReason: null,
        onChange: noop,
        onSave: noop,
        onRetry: noop,
        onReload: noop,
        onShowTheirs: noop,
      }),
    );
    assert.match(reload, />Reload</);
  });

  it("shows the conflict banner as an alert with both versions and the three choices, no border", () => {
    const html = renderToStaticMarkup(
      createElement(view.ConflictBanner, {
        conflict: { origin: "edit", path: "/workspace/plan.md", theirsText: "v2 from Pi", theirsSha256: "a".repeat(64), mineText: "v2 from Mia" },
        busy: false,
        onOverwrite: noop,
        onUseTheirs: noop,
        onCopyMine: noop,
      }),
    );
    assert.match(html, /role="alert"/);
    assert.match(html, /This file changed on the computer while you were editing\./);
    assert.match(html, /v2 from Pi/);
    assert.match(html, /v2 from Mia/);
    for (const label of ["Overwrite with mine", "Use theirs", "Copy mine"]) assert.match(html, new RegExp(`>${label}<`));
    assert.match(html, /grid gap-2 md:grid-cols-2/);
    assert.doesNotMatch(html, /\bborder\b|divide-/);
  });

  it("words the conflict made while the computer was off", () => {
    const html = renderToStaticMarkup(
      createElement(view.ConflictBanner, {
        conflict: { origin: "overlay", path: "/workspace/plan.md", theirsText: "t", theirsSha256: "a".repeat(64), mineText: "m" },
        busy: false,
        onOverwrite: noop,
        onUseTheirs: noop,
        onCopyMine: noop,
      }),
    );
    assert.match(html, /Your edit conflicts with a newer version of this file/);
  });

  it("asks a question with the safe answer first, and a blocked question has only Close", () => {
    const html = renderToStaticMarkup(
      createElement(view.ConfirmBar, { confirm: { id: "discard-draft", text: "Discard your changes?", confirmLabel: "Discard", cancelLabel: "Keep editing" }, onAnswer: noop }),
    );
    assert.match(html, /role="alertdialog"/);
    assert.ok(html.indexOf("Keep editing") < html.indexOf(">Discard<"));
    const blocked = renderToStaticMarkup(
      createElement(view.ConfirmBar, { confirm: { id: "delete-blocked", text: "Only the owner", confirmLabel: null, cancelLabel: "Close" }, onAnswer: noop }),
    );
    assert.doesNotMatch(blocked, />Delete</);
    assert.equal(renderToStaticMarkup(createElement(view.ConfirmBar, { confirm: null, onAnswer: noop })), "");
  });

  it("lists pending changes with a Discard named for each", () => {
    const entry = {
      op: "delete" as const, path: "/workspace/a.txt", directory: false, recursive: false, base_sha256: null, tree_sha256: null,
      edited_by: "ryan", edited_at: "2026-10-12T10:00:00.000Z", revision: 1, conflict: null,
    };
    const html = renderToStaticMarkup(createElement(view.PendingChangesList, { entries: [entry], onDiscard: noop, onClose: noop }));
    assert.match(html, /Deleted a.txt/);
    assert.match(html, /aria-label="Discard Deleted a.txt"/);
    const empty = renderToStaticMarkup(createElement(view.PendingChangesList, { entries: [], onDiscard: noop, onClose: noop }));
    assert.match(empty, /Nothing is waiting for the computer/);
  });

  it("keeps every button at the 44 pixel minimum used by the rest of the panel", () => {
    const html = renderToStaticMarkup(
      createElement(view.FilesToolbar, { canChange: true, pendingCount: 2, onNewFile: noop, onNewFolder: noop, onOpenPending: noop }),
    );
    assert.match(html, /Pending changes \(2\)/);
    for (const button of html.match(/<button[^>]*>/g) ?? []) assert.match(button, /min-h-11/);
  });
});
