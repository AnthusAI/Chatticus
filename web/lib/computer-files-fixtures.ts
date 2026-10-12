import type { FileContentRange, FileEntry, FileListing } from "./computer-files";
import type { ToolCardModel } from "./turn-activity";

export const FIXTURE_AS_OF = "2026-10-12T09:55:00.000Z";

function entry(partial: Partial<FileEntry> & Pick<FileEntry, "name" | "path" | "kind">): FileEntry {
  return { size: null, mode: null, sha256: null, link_target: null, ...partial };
}

/** A /workspace listing with folders, files and a link, deliberately unsorted. */
export const workspaceListing: FileListing = {
  source: "snapshot",
  as_of: FIXTURE_AS_OF,
  path: "/workspace",
  truncated: false,
  entries: [
    entry({ name: "notes.txt", path: "/workspace/notes.txt", kind: "file", size: 412, sha256: "a".repeat(64) }),
    entry({ name: "src", path: "/workspace/src", kind: "directory" }),
    entry({ name: "logo.png", path: "/workspace/logo.png", kind: "file", size: 70, sha256: "b".repeat(64) }),
    entry({ name: "latest", path: "/workspace/latest", kind: "symlink", link_target: "/workspace/src/index.ts" }),
    entry({ name: ".env", path: "/workspace/.env", kind: "file", size: 58, sha256: "c".repeat(64) }),
    entry({ name: "data.bin", path: "/workspace/data.bin", kind: "file", size: 9000 }),
    entry({ name: "docs", path: "/workspace/docs", kind: "directory" }),
  ],
};

export const emptyListing: FileListing = { ...workspaceListing, entries: [] };

function range(partial: Partial<FileContentRange> & Pick<FileContentRange, "path" | "content">): FileContentRange {
  return {
    source: "snapshot",
    as_of: FIXTURE_AS_OF,
    size: partial.content.length,
    sha256: "a".repeat(64),
    encoding: "utf8",
    binary: false,
    offset: 0,
    length: partial.content.length,
    truncated: false,
    masked: false,
    ...partial,
  };
}

export const textFileRange: FileContentRange = range({
  path: "/workspace/notes.txt",
  content: "Shopping list\n- milk\n- <script>alert(1)</script>\n- eggs\n",
});

export const maskedFileRange: FileContentRange = range({
  path: "/workspace/.env",
  content: "",
  masked: true,
  size: 58,
  length: 0,
});

export const binaryFileRange: FileContentRange = range({
  path: "/workspace/data.bin",
  content: "AAECAwQF",
  encoding: "base64",
  binary: true,
  size: 9000,
  length: 6,
  truncated: true,
});

/** A valid 1x1 PNG. */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

export const imageFileRange: FileContentRange = range({
  path: "/workspace/logo.png",
  content: TINY_PNG_BASE64,
  encoding: "base64",
  binary: true,
  size: 70,
  length: 70,
});

function card(tool: string, path: string, status: ToolCardModel["status"] = "ok"): ToolCardModel {
  return {
    callId: `${tool}:${path}:${status}`,
    tool,
    label: tool,
    kind: "generic",
    summary: null,
    status,
    durationMs: null,
    arguments: { path },
    argumentsTruncated: false,
    output: null,
    outputTruncated: false,
    openByDefault: false,
  };
}

/** Cards oldest first, as a turn would produce them. */
export const touchingCards: ToolCardModel[] = [
  card("read_workspace", "/workspace/notes.txt"),
  card("write_workspace", "/workspace/src/index.ts"),
  card("edit_workspace", "/workspace/notes.txt"),
  card("read_workspace", "src/index.ts"),
  card("read_workspace", "/etc/passwd"),
  card("write_workspace", "/workspace/never.txt", "failed"),
];
