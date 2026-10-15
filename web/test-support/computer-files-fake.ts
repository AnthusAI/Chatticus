import { createHash } from "node:crypto";

import { overlayEntrySchema, type OverlayEntry } from "../../host-protocol/src/edit-overlay.ts";
import {
  liveFileContentResponseSchema,
  liveFileDeleteResponseSchema,
  liveFileDiscardBodySchema,
  liveFileErrorSchema,
  liveFileListingResponseSchema,
  liveFileMkdirBodySchema,
  liveFileMkdirResponseSchema,
  liveFileMoveBodySchema,
  liveFileMoveResponseSchema,
  liveFileRevealBodySchema,
  liveFileStatResponseSchema,
  liveFileWatchBodySchema,
  liveFileWatchResponseSchema,
  liveFileWriteBodySchema,
  liveFileWriteResponseSchema,
} from "../../host-protocol/src/live-files.ts";

type Node = { kind: "file" | "directory"; content: string; modifiedAtMs: number };

export type FakeMode = "running" | "off" | "starting";

export type RecordedRequest = {
  method: string;
  route: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  keepalive: boolean;
};

export type ScriptedSaveAnswer = { status: number; code: string; retryAfterMs?: number };

const ROOT = "/workspace";
const CONTENT_LIMIT = 262144;

function sha256Of(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || ROOT;
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * A fake running computer behind the member file routes. It answers with the
 * JSON shapes of host-protocol/src/live-files.ts and edit-overlay.ts, and
 * validates what it sends and what it receives against those schemas, so the
 * panel is developed against the contract and not against its own guess of it.
 */
export class FakeComputerFiles {
  mode: FakeMode = "running";
  role: "owner" | "member" = "owner";
  userEmail = "ryan@example.com";
  nowMs = Date.parse("2026-10-12T10:00:00.000Z");
  savedAsOfMs = Date.parse("2026-10-12T09:55:00.000Z");
  live = new Map<string, Node>([[ROOT, { kind: "directory", content: "", modifiedAtMs: this.nowMs }]]);
  saved = new Map<string, Node>([[ROOT, { kind: "directory", content: "", modifiedAtMs: this.savedAsOfMs }]]);
  overlay: OverlayEntry[] = [];
  blobs = new Map<string, string>();
  conflictMine = new Map<string, string>();
  audit: Array<{ operation: string; path: string; user: string; source: string }> = [];
  requests: RecordedRequest[] = [];
  otherRequests: string[] = [];
  nextLiveReadTimesOut = false;
  nextSaveAnswers: ScriptedSaveAnswer[] = [];
  private revision = 0;

  private stamp(): string {
    return new Date(this.nowMs).toISOString();
  }

  setMode(mode: FakeMode): void {
    if (mode !== "running" && this.mode === "running") {
      this.saved = new Map([...this.live].map(([path, node]) => [path, { ...node, modifiedAtMs: this.savedAsOfMs }]));
    }
    this.mode = mode;
  }

  seed(target: "live" | "saved", path: string, content: string): void {
    const files = target === "live" ? this.live : this.saved;
    let at = parentOf(path);
    while (at !== ROOT && !files.has(at)) {
      files.set(at, { kind: "directory", content: "", modifiedAtMs: this.savedAsOfMs });
      at = parentOf(at);
    }
    files.set(path, { kind: "file", content, modifiedAtMs: target === "live" ? this.nowMs : this.savedAsOfMs });
  }

  seedFolder(target: "live" | "saved", path: string, fileCount: number): void {
    const files = target === "live" ? this.live : this.saved;
    files.set(path, { kind: "directory", content: "", modifiedAtMs: this.savedAsOfMs });
    for (let index = 1; index <= fileCount; index += 1) this.seed(target, `${path}/file${index}.txt`, `content ${index}`);
  }

  scriptNextSave(answer: ScriptedSaveAnswer): void {
    this.nextSaveAnswers.push(answer);
  }

  externalWrite(path: string, content: string): void {
    this.nowMs += 1000;
    const node = this.live.get(path);
    this.live.set(path, { kind: "file", content, modifiedAtMs: this.nowMs });
    if (!node) this.seed("live", path, content);
  }

  fileContent(source: "live" | "effective", path: string): string | null {
    const files = source === "live" ? this.live : this.effective().files;
    const node = files.get(path);
    return node && node.kind === "file" ? node.content : null;
  }

  private nextRevision(): number {
    this.revision += 1;
    return this.revision;
  }

  private pushEntry(entry: Record<string, unknown>): OverlayEntry {
    const parsed = overlayEntrySchema.parse(entry);
    this.overlay = [...this.overlay.filter((existing) => existing.path !== parsed.path), parsed];
    return parsed;
  }

  private entryBase(path: string): Record<string, unknown> {
    return {
      path,
      edited_by: "ryan",
      edited_at: this.stamp(),
      revision: this.nextRevision(),
      conflict: null,
    };
  }

  seedPendingEdit(path: string, content: string): void {
    const base = this.saved.get(path);
    const baseSha = base ? sha256Of(base.content) : null;
    const sha = sha256Of(content);
    this.blobs.set(sha, content);
    this.pushEntry({
      ...this.entryBase(path),
      op: "put",
      sha256: sha,
      size: Buffer.byteLength(content),
      mode: "644",
      base_sha256: baseSha,
      from: null,
      from_sha256: null,
    });
  }

  seedPendingConflict(path: string, mine: string, newerSaved: string): void {
    this.seed("saved", path, "the text my edit started from");
    this.seedPendingEdit(path, mine);
    this.saved.set(path, { kind: "file", content: newerSaved, modifiedAtMs: this.savedAsOfMs + 60000 });
    this.conflictMine.set(path, mine);
  }

  seedPendingDelete(path: string): void {
    const node = this.saved.get(path);
    this.pushEntry({
      ...this.entryBase(path),
      op: "delete",
      directory: node?.kind === "directory",
      recursive: false,
      base_sha256: node && node.kind === "file" ? sha256Of(node.content) : null,
      tree_sha256: null,
    });
  }

  seedPendingMkdir(path: string): void {
    this.pushEntry({ ...this.entryBase(path), op: "mkdir", mode: "775" });
  }

  private treeHash(files: Map<string, Node>, directory: string): string {
    const prefix = `${directory}/`;
    const lines = [...files.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, node]) => ({
        relative: path.slice(prefix.length),
        line: `${node.kind === "directory" ? "dir" : "file"}\0${path.slice(prefix.length)}\0${node.kind === "directory" ? 0 : Buffer.byteLength(node.content)}\n`,
      }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)));
    return createHash("sha256").update(lines.map((entry) => entry.line).join("")).digest("hex");
  }

  private effective(): { files: Map<string, Node>; states: Map<string, "pending" | "conflict"> } {
    if (this.mode === "running") return { files: this.live, states: new Map() };
    const files = new Map(this.saved);
    const states = new Map<string, "pending" | "conflict">();
    const ordered = [...this.overlay].sort((left, right) => rank(left.op) - rank(right.op));
    for (const entry of ordered) {
      if (this.conflictMine.has(entry.path)) {
        states.set(entry.path, "conflict");
        continue;
      }
      states.set(entry.path, "pending");
      if (entry.op === "mkdir") {
        files.set(entry.path, { kind: "directory", content: "", modifiedAtMs: this.nowMs });
      } else if (entry.op === "move") {
        for (const [path, node] of [...files]) {
          if (path === entry.from || path.startsWith(`${entry.from}/`)) {
            files.delete(path);
            files.set(entry.path + path.slice(entry.from.length), node);
          }
        }
      } else if (entry.op === "put") {
        files.set(entry.path, { kind: "file", content: this.blobs.get(entry.sha256) ?? "", modifiedAtMs: Date.parse(entry.edited_at) });
      } else {
        for (const path of [...files.keys()]) {
          if (path === entry.path || path.startsWith(`${entry.path}/`)) files.delete(path);
        }
      }
    }
    return { files, states };
  }

  private entryJson(files: Map<string, Node>, states: Map<string, "pending" | "conflict">, path: string) {
    const node = files.get(path) as Node;
    const directory = node.kind === "directory";
    return {
      name: nameOf(path),
      path,
      kind: node.kind,
      size: directory ? null : Buffer.byteLength(node.content),
      mode: directory ? "775" : "644",
      sha256: directory ? null : sha256Of(node.content),
      link_target: null,
      modified_at: new Date(node.modifiedAtMs).toISOString(),
      overlay: states.get(path) ?? "none",
      tree_sha256: directory ? this.treeHash(files, path) : null,
    };
  }

  private provenance(): { source: "live" | "snapshot"; as_of: string | null; stale: boolean; fallback_reason: string | null; retry_after_ms?: number } {
    if (this.mode === "running") {
      if (this.nextLiveReadTimesOut) {
        this.nextLiveReadTimesOut = false;
        return { source: "snapshot", as_of: new Date(this.savedAsOfMs).toISOString(), stale: true, fallback_reason: "owner_timeout", retry_after_ms: 2000 };
      }
      return { source: "live", as_of: this.stamp(), stale: false, fallback_reason: null };
    }
    return { source: "snapshot", as_of: new Date(this.savedAsOfMs).toISOString(), stale: false, fallback_reason: null };
  }

  private respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  }

  private refuse(status: number, error: string, extra: Record<string, unknown> = {}): Response {
    const body = liveFileErrorSchema.parse({ error, message: `fake: ${error}`, ...extra });
    return this.respond(status, body);
  }

  private snapshotViewForStale(): { files: Map<string, Node>; states: Map<string, "pending" | "conflict"> } {
    return { files: this.saved, states: new Map() };
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://panel.test");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
    const match = /^\/api\/orgs\/[^/]+\/computer\/files(\/[a-z/]+)?$/.exec(url.pathname);
    if (!match) {
      this.otherRequests.push(`${method} ${url.pathname}`);
      return this.refuse(404, "not_found");
    }
    const route = match[1] ?? "";
    const query = Object.fromEntries(url.searchParams.entries());
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    this.requests.push({ method, route, query, headers, body, keepalive: init?.keepalive === true });
    try {
      return this.handle(method, route, query, headers, body);
    } catch (error) {
      return this.respond(500, { error: "fake_failed", message: error instanceof Error ? error.message : String(error) });
    }
  };

  private handle(method: string, route: string, query: Record<string, string>, headers: Record<string, string>, body: unknown): Response {
    if (method === "GET" && route === "") return this.list(query.path ?? ROOT);
    if (method === "GET" && route === "/stat") return this.stat(query.path ?? ROOT);
    if (method === "GET" && route === "/content") return this.content(query);
    if (method === "PUT" && route === "/content") return this.write(query.path ?? "", headers, body);
    if (method === "POST" && route === "/reveal") return this.reveal(body);
    if (method === "POST" && route === "/watch") return this.watch(body);
    if (method === "DELETE" && route === "") return this.remove(query, headers);
    if (method === "POST" && route === "/move") return this.move(headers, body);
    if (method === "POST" && route === "/directories") return this.makeDirectory(body);
    if (method === "GET" && route === "/overlay") return this.respond(200, { entries: this.overlay });
    if (method === "POST" && route === "/overlay/discard") return this.discard(body);
    return this.refuse(404, "not_found");
  }

  private view(provenance: { stale: boolean }) {
    return provenance.stale ? this.snapshotViewForStale() : this.effective();
  }

  private list(path: string): Response {
    const provenance = this.provenance();
    const { files, states } = this.view(provenance);
    const node = files.get(path);
    if (!node) return this.refuse(404, "not_found");
    if (node.kind !== "directory") return this.refuse(422, "not_a_directory");
    const entries = [...files.keys()].filter((candidate) => candidate !== path && parentOf(candidate) === path).map((child) => this.entryJson(files, states, child));
    return this.respond(200, liveFileListingResponseSchema.parse({ ...provenance, path, truncated: false, entries }));
  }

  private stat(path: string): Response {
    const provenance = this.provenance();
    const { files, states } = this.view(provenance);
    if (!files.has(path)) return this.refuse(404, "not_found");
    const entry = this.entryJson(files, states, path);
    const etag = entry.kind === "directory" ? entry.tree_sha256 : entry.sha256;
    return this.respond(200, liveFileStatResponseSchema.parse({ ...provenance, entry }), etag ? { ETag: `"${etag}"` } : {});
  }

  private content(query: Record<string, string>): Response {
    const path = query.path ?? "";
    const provenance = this.provenance();
    const { files, states } = this.view(provenance);
    const node = files.get(path);
    if (!node) return this.refuse(404, "not_found");
    if (node.kind !== "file") return this.refuse(422, "not_a_file");
    const mine = query.variant === "mine" ? this.conflictMine.get(path) : undefined;
    const text = mine ?? node.content;
    const masked = nameOf(path).startsWith(".env");
    return this.respond(200, this.contentBody(provenance, path, text, node, states.get(path) ?? "none", masked, false, query));
  }

  private contentBody(
    provenance: ReturnType<FakeComputerFiles["provenance"]>,
    path: string,
    text: string,
    node: Node,
    overlay: "none" | "pending" | "conflict",
    masked: boolean,
    revealed: boolean,
    query: Record<string, string>,
  ) {
    const bytes = Buffer.from(text);
    const offset = Number(query.offset ?? 0);
    const length = Math.min(Number(query.length ?? CONTENT_LIMIT), CONTENT_LIMIT);
    const slice = masked && !revealed ? Buffer.alloc(0) : bytes.subarray(offset, offset + length);
    const mineSha = overlay === "conflict" ? sha256Of(this.conflictMine.get(path) ?? "") : null;
    return liveFileContentResponseSchema.parse({
      ...provenance,
      path,
      size: bytes.length,
      sha256: sha256Of(text),
      encoding: "utf8",
      binary: false,
      offset,
      length: slice.length,
      content: slice.toString("utf8"),
      truncated: offset + slice.length < bytes.length && !(masked && !revealed),
      masked: masked && !revealed,
      revealed,
      editable: bytes.length <= CONTENT_LIMIT && (!masked || revealed) && !provenance.stale,
      modified_at: new Date(node.modifiedAtMs).toISOString(),
      overlay,
      mine_sha256: mineSha,
    });
  }

  private reveal(body: unknown): Response {
    const parsed = liveFileRevealBodySchema.parse(body);
    const provenance = this.provenance();
    const { files, states } = this.view(provenance);
    const node = files.get(parsed.path);
    if (!node || node.kind !== "file") return this.refuse(404, "not_found");
    this.audit.push({ operation: "reveal", path: parsed.path, user: this.userEmail, source: provenance.source });
    return this.respond(
      200,
      this.contentBody(provenance, parsed.path, node.content, node, states.get(parsed.path) ?? "none", true, true, {}),
      { "Cache-Control": "no-store" },
    );
  }

  private watch(body: unknown): Response {
    liveFileWatchBodySchema.parse(body);
    const state = this.mode === "running" ? "live" : this.mode === "starting" ? "starting" : "off";
    return this.respond(
      200,
      liveFileWatchResponseSchema.parse({
        state,
        interactive_until: state === "live" ? new Date(this.nowMs + 45000).toISOString() : null,
        poll_interval_ms: state === "live" ? 1000 : null,
      }),
    );
  }

  private precondition(headers: Record<string, string>): { type: "if_match"; sha256: string } | { type: "if_none_match" } | Response {
    const ifMatch = headers["if-match"];
    const ifNoneMatch = headers["if-none-match"];
    if ((ifMatch === undefined) === (ifNoneMatch === undefined)) return this.refuse(428, "precondition_required");
    if (ifNoneMatch !== undefined) {
      return ifNoneMatch === "*" ? { type: "if_none_match" } : this.refuse(400, "invalid_body");
    }
    const found = /^"([0-9a-f]{64})"$/.exec(ifMatch as string);
    return found ? { type: "if_match", sha256: found[1] } : this.refuse(400, "invalid_body");
  }

  private write(path: string, headers: Record<string, string>, body: unknown): Response {
    const scripted = this.nextSaveAnswers.shift();
    if (scripted) {
      return this.refuse(scripted.status, scripted.code, scripted.retryAfterMs ? { retry_after_ms: scripted.retryAfterMs } : {});
    }
    const parsed = liveFileWriteBodySchema.parse(body);
    const precondition = this.precondition(headers);
    if (precondition instanceof Response) return precondition;
    const { files } = this.effective();
    const existing = files.get(path);
    if (precondition.type === "if_none_match" && existing) return this.refuse(409, "already_exists");
    if (precondition.type === "if_match") {
      if (!existing || existing.kind !== "file") return this.refuse(404, "not_found");
      const current = sha256Of(existing.content);
      if (current !== precondition.sha256) return this.refuse(409, "precondition_failed", { current_sha256: current });
    }
    if (!files.has(parentOf(path))) return this.refuse(404, "parent_missing");
    const sha = sha256Of(parsed.content);
    const previous = existing ? sha256Of(existing.content) : null;
    if (this.mode === "running") {
      this.nowMs += 1000;
      this.live.set(path, { kind: "file", content: parsed.content, modifiedAtMs: this.nowMs });
      this.audit.push({ operation: "write", path, user: this.userEmail, source: "live" });
    } else {
      this.blobs.set(sha, parsed.content);
      const savedNode = this.saved.get(path);
      this.pushEntry({
        ...this.entryBase(path),
        op: "put",
        sha256: sha,
        size: Buffer.byteLength(parsed.content),
        mode: "644",
        base_sha256: savedNode && savedNode.kind === "file" ? sha256Of(savedNode.content) : null,
        from: null,
        from_sha256: null,
      });
      this.conflictMine.delete(path);
      this.audit.push({ operation: "write", path, user: this.userEmail, source: "overlay" });
    }
    const result = liveFileWriteResponseSchema.parse({
      source: this.mode === "running" ? "live" : "overlay",
      as_of: this.stamp(),
      path,
      created: existing === undefined,
      size: Buffer.byteLength(parsed.content),
      sha256: sha,
      previous_sha256: previous,
      modified_at: this.stamp(),
      kept_as: null,
      backed_up: this.mode !== "running",
    });
    return this.respond(200, result, { ETag: `"${sha}"` });
  }

  private remove(query: Record<string, string>, headers: Record<string, string>): Response {
    const path = query.path ?? "";
    const ifMatch = /^"([0-9a-f]{64})"$/.exec(headers["if-match"] ?? "");
    if (!headers["if-match"]) return this.refuse(428, "precondition_required");
    if (!ifMatch) return this.refuse(400, "invalid_body");
    const { files } = this.effective();
    const node = files.get(path);
    if (!node) return this.refuse(404, "not_found");
    const directory = node.kind === "directory";
    const current = directory ? this.treeHash(files, path) : sha256Of(node.content);
    if (current !== ifMatch[1]) return this.refuse(409, "precondition_failed", { current_sha256: current });
    const descendants = [...files.keys()].filter((candidate) => candidate.startsWith(`${path}/`));
    const recursive = query.recursive === "true";
    if (directory && descendants.length > 0 && !recursive) return this.refuse(409, "directory_not_empty");
    if (directory && descendants.length > 0 && this.role !== "owner") return this.refuse(403, "owner_role_required");
    if (this.mode === "running") {
      for (const key of [path, ...descendants]) this.live.delete(key);
    } else {
      this.overlay = this.overlay.filter((entry) => entry.path !== path && !entry.path.startsWith(`${path}/`));
      this.pushEntry({
        ...this.entryBase(path),
        op: "delete",
        directory,
        recursive: directory && descendants.length > 0,
        base_sha256: directory ? null : current,
        tree_sha256: directory ? current : null,
      });
    }
    this.audit.push({ operation: "delete", path, user: this.userEmail, source: this.mode === "running" ? "live" : "overlay" });
    return this.respond(
      200,
      liveFileDeleteResponseSchema.parse({
        source: this.mode === "running" ? "live" : "overlay",
        as_of: this.stamp(),
        path,
        directory,
        removed: 1 + descendants.length,
        kept_as: null,
        backed_up: this.mode !== "running",
      }),
    );
  }

  private move(headers: Record<string, string>, body: unknown): Response {
    const parsed = liveFileMoveBodySchema.parse(body);
    const ifMatch = /^"([0-9a-f]{64})"$/.exec(headers["if-match"] ?? "");
    if (!headers["if-match"]) return this.refuse(428, "precondition_required");
    if (!ifMatch) return this.refuse(400, "invalid_body");
    const { files } = this.effective();
    const node = files.get(parsed.from);
    if (!node) return this.refuse(404, "not_found");
    const directory = node.kind === "directory";
    const current = directory ? this.treeHash(files, parsed.from) : sha256Of(node.content);
    if (current !== ifMatch[1]) return this.refuse(409, "precondition_failed", { current_sha256: current });
    if (files.has(parsed.to)) return this.refuse(409, "already_exists");
    if (parsed.to.startsWith(`${parsed.from}/`)) return this.refuse(422, "invalid_move");
    if (this.mode === "running") {
      for (const [path, entry] of [...this.live]) {
        if (path === parsed.from || path.startsWith(`${parsed.from}/`)) {
          this.live.delete(path);
          this.live.set(parsed.to + path.slice(parsed.from.length), entry);
        }
      }
    } else {
      this.pushEntry({
        ...this.entryBase(parsed.to),
        op: "move",
        from: parsed.from,
        directory,
        sha256: directory ? null : current,
        tree_sha256: directory ? current : null,
        size: directory ? 0 : Buffer.byteLength(node.content),
        mode: directory ? "775" : "644",
      });
    }
    this.audit.push({ operation: "move", path: parsed.from, user: this.userEmail, source: this.mode === "running" ? "live" : "overlay" });
    return this.respond(
      200,
      liveFileMoveResponseSchema.parse({
        source: this.mode === "running" ? "live" : "overlay",
        as_of: this.stamp(),
        from: parsed.from,
        to: parsed.to,
        directory,
        sha256: directory ? null : current,
        tree_sha256: directory ? current : null,
        backed_up: this.mode !== "running",
      }),
    );
  }

  private makeDirectory(body: unknown): Response {
    const parsed = liveFileMkdirBodySchema.parse(body);
    const { files } = this.effective();
    if (!files.has(parentOf(parsed.path))) return this.refuse(404, "parent_missing");
    const existed = files.get(parsed.path)?.kind === "directory";
    if (files.has(parsed.path) && !existed) return this.refuse(409, "already_exists");
    if (!existed) {
      if (this.mode === "running") this.live.set(parsed.path, { kind: "directory", content: "", modifiedAtMs: this.nowMs });
      else this.pushEntry({ ...this.entryBase(parsed.path), op: "mkdir", mode: "775" });
      this.audit.push({ operation: "mkdir", path: parsed.path, user: this.userEmail, source: this.mode === "running" ? "live" : "overlay" });
    }
    return this.respond(
      200,
      liveFileMkdirResponseSchema.parse({
        source: this.mode === "running" ? "live" : "overlay",
        as_of: this.stamp(),
        path: parsed.path,
        created: !existed,
        backed_up: this.mode !== "running",
      }),
    );
  }

  private discard(body: unknown): Response {
    const parsed = liveFileDiscardBodySchema.parse(body);
    const found = this.overlay.find((entry) => entry.path === parsed.path && entry.revision === parsed.revision);
    if (!found) return this.refuse(404, "not_found");
    this.overlay = this.overlay.filter((entry) => entry !== found);
    this.conflictMine.delete(parsed.path);
    this.audit.push({ operation: "discard", path: parsed.path, user: this.userEmail, source: "overlay" });
    return this.respond(200, { discarded: true });
  }

  listingNames(directory: string): string[] {
    const { files } = this.effective();
    return [...files.keys()].filter((path) => path !== directory && parentOf(path) === directory).map(nameOf);
  }

  exists(path: string): boolean {
    return this.effective().files.has(path);
  }
}

function rank(op: OverlayEntry["op"]): number {
  return { mkdir: 0, move: 1, put: 2, delete: 3 }[op];
}
