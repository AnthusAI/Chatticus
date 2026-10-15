import type { TurnEvent } from "./api";

const TURN_ID = "turn-fixture";

function sequence(events: Array<Omit<TurnEvent, "seq" | "turn_id">>): TurnEvent[] {
  return events.map((event, index) => ({ ...event, seq: index + 1, turn_id: TURN_ID }));
}

/** A computer boots, one terminal call succeeds, then the answer streams. */
export const terminalCallTurn: TurnEvent[] = sequence([
  { kind: "turn.started" },
  { kind: "attempt.claimed" },
  { kind: "model.request" },
  { kind: "computer.starting", detail: "Starting your computer" },
  { kind: "turn.waiting", body: "workspace" },
  { kind: "computer.ready", detail: "Computer ready" },
  { kind: "model.request" },
  {
    kind: "tool.call",
    tool: "run_terminal",
    call_id: "call-1",
    summary: "Running: ls -la /workspace",
    arguments: { command: "ls -la /workspace" },
    arguments_truncated: false,
  },
  {
    kind: "tool.result",
    tool: "run_terminal",
    call_id: "call-1",
    ok: true,
    summary: "Exit 0",
    output: "total 8\ndrwxr-xr-x 2 bot bot 4096 Oct 11 09:00 .\n-rw-r--r-- 1 bot bot   12 Oct 11 09:00 notes.txt",
    output_truncated: false,
    duration_ms: 420,
  },
  { kind: "model.request" },
  { kind: "turn.token", token: "There is one file, " },
  { kind: "turn.token", token: "notes.txt." },
  { kind: "turn.completed" },
]);

/** A command that fails; the failed card opens by default. */
export const failedCallTurn: TurnEvent[] = sequence([
  { kind: "turn.started" },
  { kind: "model.request" },
  {
    kind: "tool.call",
    tool: "run_terminal",
    call_id: "call-bad",
    summary: "Running: npm test",
    arguments: { command: "npm test" },
  },
  {
    kind: "tool.result",
    tool: "run_terminal",
    call_id: "call-bad",
    ok: false,
    summary: "Exit 1: 2 tests failed",
    output: "FAIL src/sum.test.ts\n  expected 4 received 5",
    duration_ms: 8300,
  },
  { kind: "model.request" },
]);

/** An edit shows its path and old and new text. */
export const editCallTurn: TurnEvent[] = sequence([
  { kind: "turn.started" },
  { kind: "model.request" },
  {
    kind: "tool.call",
    tool: "edit_workspace",
    call_id: "call-edit",
    summary: "Editing src/greeting.ts",
    arguments: { path: "src/greeting.ts", old_text: "return \"helo\";", new_text: "return \"hello\";" },
  },
  { kind: "tool.result", tool: "edit_workspace", call_id: "call-edit", ok: true, summary: "Edited 1 block", duration_ms: 35 },
  { kind: "model.request" },
]);

/** A long output the server truncated. */
export const longOutputTurn: TurnEvent[] = sequence([
  { kind: "turn.started" },
  { kind: "model.request" },
  {
    kind: "tool.call",
    tool: "run_terminal",
    call_id: "call-long",
    summary: "Running: cat build.log",
    arguments: { command: "cat build.log" },
  },
  {
    kind: "tool.result",
    tool: "run_terminal",
    call_id: "call-long",
    ok: true,
    summary: "Exit 0",
    output: Array.from({ length: 60 }, (_, line) => `line ${line + 1}: compiled module ${line + 1}`).join("\n"),
    output_truncated: true,
    duration_ms: 1900,
  },
  { kind: "model.request" },
]);

/** Twelve quick calls, the shape that must stay a compact readable list. */
export const manyCallsTurn: TurnEvent[] = sequence([
  { kind: "turn.started" },
  ...Array.from({ length: 12 }, (_, index) => [
    { kind: "tool.call", tool: "read_workspace", call_id: `call-${index}`, summary: `Reading src/file-${index + 1}.ts`, arguments: { path: `src/file-${index + 1}.ts` } },
    { kind: "tool.result", tool: "read_workspace", call_id: `call-${index}`, ok: true, summary: "Done", output: "contents", duration_ms: 12 },
  ]).flat(),
]);

/** A turn whose tool events lack every optional field, with a null duration (a call begun under an earlier attempt). */
export const missingOptionalFieldsTurn: TurnEvent[] = sequence([
  { kind: "turn.started" },
  { kind: "tool.call", tool: "run_terminal", call_id: "call-bare" },
  { kind: "tool.result", tool: "run_terminal", call_id: "call-bare", ok: true, duration_ms: null },
  { kind: "turn.token", token: "Done." },
  { kind: "turn.completed" },
]);
