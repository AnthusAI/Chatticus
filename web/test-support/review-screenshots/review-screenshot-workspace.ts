import type { Bot, Channel, Computer, Message, Task, ToolActivityItem, Turn } from "../../lib/api";
import type { MeResponse } from "../../lib/me";
import { FakeComputerFiles } from "../computer-files-fake";
import { FakeCostApi, type FakeTurn } from "../costs-fake";

export const REVIEW_SCREENSHOT_TENANT_ID = "anthus";
export const REVIEW_SCREENSHOT_USER_ID = "member-ryan";
export const REVIEW_SCREENSHOT_USER_EMAIL = "ryan@example.com";
export const REVIEW_SCREENSHOT_FIXED_TIME = "2026-10-12T10:00:00.000Z";

const PLANNING_CHANNEL_ID = "channel-planning";
const DIRECT_CHANNEL_ID = "channel-pi";

export type ReviewScreenshotApiAnswer = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type ReviewScreenshotApiRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

const seededBots: Bot[] = [
  { bot_id: "bot-pi", tenant_id: REVIEW_SCREENSHOT_TENANT_ID, user_id: REVIEW_SCREENSHOT_USER_ID, name: "Pi", memory: {} },
  { bot_id: "bot-scout", tenant_id: REVIEW_SCREENSHOT_TENANT_ID, user_id: REVIEW_SCREENSHOT_USER_ID, name: "Scout", memory: {} },
];

const seededChannels: Channel[] = [
  {
    channel_id: PLANNING_CHANNEL_ID,
    tenant_id: REVIEW_SCREENSHOT_TENANT_ID,
    user_id: REVIEW_SCREENSHOT_USER_ID,
    kind: "named",
    name: "Planning",
    participants: [
      { kind: "human", actor_id: REVIEW_SCREENSHOT_USER_ID },
      { kind: "bot", actor_id: "bot-pi" },
      { kind: "bot", actor_id: "bot-scout" },
    ],
    next_seq: 5,
  },
  {
    channel_id: DIRECT_CHANNEL_ID,
    tenant_id: REVIEW_SCREENSHOT_TENANT_ID,
    user_id: REVIEW_SCREENSHOT_USER_ID,
    kind: "direct",
    name: null,
    participants: [
      { kind: "human", actor_id: REVIEW_SCREENSHOT_USER_ID },
      { kind: "bot", actor_id: "bot-pi" },
    ],
    next_seq: 3,
  },
];

const planningReplyActivity: ToolActivityItem[] = [
  {
    call_id: "call-read-readme",
    tool: "read",
    summary: "Read /workspace/README.md",
    arguments: { path: "/workspace/README.md" },
    arguments_truncated: false,
    ok: true,
    result_summary: "42 lines",
    output: "# Chatticus\n\nA serverless platform that runs Pi agents as a software factory.",
    output_truncated: false,
    duration_ms: 180,
  },
  {
    call_id: "call-run-tests",
    tool: "bash",
    summary: "npm test",
    arguments: { command: "npm test" },
    arguments_truncated: false,
    ok: true,
    result_summary: "128 passing",
    output: "128 passing (4s)",
    output_truncated: false,
    duration_ms: 4120,
  },
];

function messageOf(channelId: string, seq: number, fields: Partial<Message> & Pick<Message, "author_kind" | "author_id" | "body">): Message {
  return {
    message_id: `${channelId}-message-${seq}`,
    channel_id: channelId,
    tenant_id: REVIEW_SCREENSHOT_TENANT_ID,
    seq,
    addressed_to_bot_id: null,
    created_at: new Date(Date.parse(REVIEW_SCREENSHOT_FIXED_TIME) - (10 - seq) * 60_000).toISOString(),
    ...fields,
  };
}

const seededMessagesByChannel: Record<string, Message[]> = {
  [PLANNING_CHANNEL_ID]: [
    messageOf(PLANNING_CHANNEL_ID, 1, {
      author_kind: "human",
      author_id: REVIEW_SCREENSHOT_USER_ID,
      addressed_to_bot_id: "bot-pi",
      body: "Pi, can you check that the test suite still passes and tell me what changed in the README?",
    }),
    messageOf(PLANNING_CHANNEL_ID, 2, {
      author_kind: "bot",
      author_id: "bot-pi",
      activity: planningReplyActivity,
      body: [
        "All **128 tests pass**. The README now covers three things:",
        "",
        "1. How a bot answers while its computer is still booting.",
        "2. The cost markers under each reply.",
        "3. The panel plugins beside the conversation.",
        "",
        "```ts",
        "export function panelSizeForPlugin(pluginId: CorePanelPluginId, requestedSize: PanelSize): PanelSize {",
        "  return requestedSize;",
        "}",
        "```",
      ].join("\n"),
    }),
    messageOf(PLANNING_CHANNEL_ID, 3, {
      author_kind: "human",
      author_id: REVIEW_SCREENSHOT_USER_ID,
      addressed_to_bot_id: "bot-scout",
      body: "Scout, what should we tackle next?",
    }),
    messageOf(PLANNING_CHANNEL_ID, 4, {
      author_kind: "bot",
      author_id: "bot-scout",
      body: "The Kanbus board panel is the next open story. I can draft the plan for it if you like.",
    }),
  ],
  [DIRECT_CHANNEL_ID]: [
    messageOf(DIRECT_CHANNEL_ID, 1, {
      author_kind: "human",
      author_id: REVIEW_SCREENSHOT_USER_ID,
      addressed_to_bot_id: "bot-pi",
      body: "Morning, Pi.",
    }),
    messageOf(DIRECT_CHANNEL_ID, 2, {
      author_kind: "bot",
      author_id: "bot-pi",
      body: "Morning. Nothing is waiting on you today.",
    }),
  ],
};

const seededTasks: Task[] = [
  {
    task_id: "task-kanbus-panel",
    tenant_id: REVIEW_SCREENSHOT_TENANT_ID,
    user_id: REVIEW_SCREENSHOT_USER_ID,
    title: "Plan the Kanbus board panel",
    status: "open",
    evidence: null,
    close_reason: null,
    created_by_bot_id: "bot-scout",
    updated_by_bot_id: null,
  },
  {
    task_id: "task-test-suite",
    tenant_id: REVIEW_SCREENSHOT_TENANT_ID,
    user_id: REVIEW_SCREENSHOT_USER_ID,
    title: "Check the test suite",
    status: "done",
    evidence: "128 passing",
    close_reason: "completed",
    created_by_bot_id: "bot-pi",
    updated_by_bot_id: "bot-pi",
  },
];

const seededComputer: Computer = {
  computer_id: "computer-anthus",
  tenant_id: REVIEW_SCREENSHOT_TENANT_ID,
  stopped: false,
  policy: "on_demand",
  host_start_generation: 1,
};

const seededCostTurns: FakeTurn[] = [
  {
    name: "turn-planning-readme",
    bot: "Pi",
    channel: "Planning",
    month: "2026-10",
    calls: [
      { model: "gpt-5.4", costUsd: "0.0184" },
      { model: "gpt-5.4-mini", costUsd: "0.0021" },
    ],
    status: "completed",
    source: "session",
    promptSeq: 1,
    replySeq: 2,
  },
  {
    name: "turn-planning-next",
    bot: "Scout",
    channel: "Planning",
    month: "2026-10",
    calls: [{ model: "gpt-5.4-mini", costUsd: "0.0009" }],
    status: "completed",
    source: "session",
    promptSeq: 3,
    replySeq: 4,
  },
  {
    name: "turn-direct-morning",
    bot: "Pi",
    channel: "Pi",
    month: "2026-10",
    calls: [{ model: "gpt-5.4-mini", costUsd: "0.0004" }],
    status: "completed",
    source: "session",
    promptSeq: 1,
    replySeq: 2,
  },
  {
    name: "turn-september-review",
    bot: "Pi",
    channel: "Planning",
    month: "2026-09",
    calls: [{ model: "gpt-5.4", costUsd: "0.2410" }],
    status: "completed",
    source: "session",
    promptSeq: null,
    replySeq: null,
  },
];

const latestTurnByChannel: Record<string, Turn> = {
  [PLANNING_CHANNEL_ID]: {
    turn_id: "turn-planning-next",
    tenant_id: REVIEW_SCREENSHOT_TENANT_ID,
    channel_id: PLANNING_CHANNEL_ID,
    bot_id: "bot-scout",
    status: "completed",
    waiting_for: null,
    terminal_reason: null,
    prompt_message_seq: 3,
  },
  [DIRECT_CHANNEL_ID]: {
    turn_id: "turn-direct-morning",
    tenant_id: REVIEW_SCREENSHOT_TENANT_ID,
    channel_id: DIRECT_CHANNEL_ID,
    bot_id: "bot-pi",
    status: "completed",
    waiting_for: null,
    terminal_reason: null,
    prompt_message_seq: 1,
  },
};

const seededMe: MeResponse = {
  email: REVIEW_SCREENSHOT_USER_EMAIL,
  user_id: REVIEW_SCREENSHOT_USER_ID,
  organizations: [
    {
      tenant_id: REVIEW_SCREENSHOT_TENANT_ID,
      name: "Anthus",
      status: "enabled",
      role: "owner",
      monthly_aws_spend_ceiling_usd: "50",
      computer_work_paused: false,
      computer_work_paused_reason: null,
    },
  ],
};

function jsonAnswer(status: number, body: unknown): ReviewScreenshotApiAnswer {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function answerOfResponse(response: Response): Promise<ReviewScreenshotApiAnswer> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, body: await response.text() };
}

type SeededKanbusIssue = {
  id: string;
  title: string;
  type: string;
  status: string;
  priority: number;
  labels: string[];
  parent?: string;
  updated_at: string;
};

const seededKanbusIssues: SeededKanbusIssue[] = [
  { id: "chatticus-daa715", title: "Workspace redesign", type: "epic", status: "in_progress", priority: 1, labels: ["web", "ui"], updated_at: "2026-10-12T09:40:00Z" },
  { id: "chatticus-ecd088", title: "Kanbus board plugin", type: "task", status: "in_progress", priority: 1, labels: ["web", "ui"], parent: "chatticus-daa715", updated_at: "2026-10-12T09:50:00Z" },
  { id: "chatticus-3a10c2", title: "Monaco code editor plugin", type: "task", status: "open", priority: 2, labels: ["web"], parent: "chatticus-daa715", updated_at: "2026-10-11T16:00:00Z" },
  { id: "chatticus-77be90", title: "Browser tab plugin", type: "task", status: "open", priority: 2, labels: ["web"], parent: "chatticus-daa715", updated_at: "2026-10-11T15:00:00Z" },
  { id: "chatticus-9ac621", title: "Hosted organization spend meter", type: "bug", status: "open", priority: 0, labels: ["cost"], updated_at: "2026-10-12T08:00:00Z" },
  { id: "chatticus-5d2f14", title: "Dark mode polish", type: "task", status: "backlog", priority: 3, labels: ["ui"], parent: "chatticus-daa715", updated_at: "2026-10-10T12:00:00Z" },
  { id: "chatticus-c81e07", title: "Wait for the vendor key rotation", type: "task", status: "blocked", priority: 2, labels: ["ops"], updated_at: "2026-10-09T12:00:00Z" },
  { id: "chatticus-0f4a39", title: "Per-call cost records", type: "task", status: "closed", priority: 1, labels: ["cost"], updated_at: "2026-10-12T07:00:00Z" },
  { id: "chatticus-b9d6e2", title: "Resizable sidebar and panel", type: "task", status: "closed", priority: 2, labels: ["web", "ui"], parent: "chatticus-daa715", updated_at: "2026-10-11T10:00:00Z" },
];

/**
 * The seeded organization the review screenshots are taken in: one signed-in owner, two bots, a named channel with
 * a worked conversation, a direct channel, a running computer with files, and the cost history behind the replies.
 * It answers every API route the workspace calls, so a static export renders the real UI without a backend, and it
 * records any route it does not know so a new call shows up in the job log instead of as a silently broken shot.
 */
export class ReviewScreenshotWorkspace {
  readonly costs = new FakeCostApi();
  readonly files = new FakeComputerFiles();
  readonly unansweredRoutes: string[] = [];

  constructor() {
    this.costs.seed(seededCostTurns);
    this.files.userEmail = REVIEW_SCREENSHOT_USER_EMAIL;
    this.files.seed("live", "/workspace/README.md", "# Chatticus\n\nA serverless platform that runs Pi agents as a software factory.\n");
    this.files.seed("live", "/workspace/src/panel-plugins.ts", "export const CORE_PANEL_PLUGINS = [\"context\", \"files\", \"costs\"];\n");
    seededKanbusIssues.forEach((issue) => this.files.seed("live", `/workspace/chatticus/project/issues/${issue.id}.json`, JSON.stringify(issue)));
    this.files.seed("live", "/workspace/notes/kanbus-panel-plan.md", "# Kanbus board panel\n\n- Read the board from the computer\n- Show it beside the conversation\n");
  }

  async answer(request: ReviewScreenshotApiRequest): Promise<ReviewScreenshotApiAnswer> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "");
    const method = request.method.toUpperCase();
    const fetchInit: RequestInit = {
      method,
      headers: request.headers,
      body: request.body ?? undefined,
    };

    if (/^\/orgs\/[^/]+\/computer\/files/.test(path)) {
      return answerOfResponse(await this.files.fetch(request.url, fetchInit));
    }
    if (/^\/orgs\/[^/]+\/(costs|channels\/[^/]+\/cost$|turns\/[^/]+\/cost$)/.test(path)) {
      return answerOfResponse(await this.costs.fetch(request.url, fetchInit));
    }

    const workspaceAnswer = this.workspaceRoute(method, path);
    if (workspaceAnswer) return workspaceAnswer;

    this.unansweredRoutes.push(`${method} ${url.pathname}${url.search}`);
    return jsonAnswer(404, { detail: "The review screenshot workspace does not answer this route." });
  }

  private workspaceRoute(method: string, path: string): ReviewScreenshotApiAnswer | null {
    if (method !== "GET") return null;
    if (path === "/me") return jsonAnswer(200, seededMe);
    if (path === "/health") return jsonAnswer(200, { environment: "review-screenshots", status: "ok" });

    const organizationMatch = /^\/orgs\/([^/]+)(\/.*)$/.exec(path);
    if (!organizationMatch || decodeURIComponent(organizationMatch[1]) !== REVIEW_SCREENSHOT_TENANT_ID) return null;
    const organizationPath = organizationMatch[2];
    const userPrefix = `/users/${REVIEW_SCREENSHOT_USER_ID}`;

    if (organizationPath === `${userPrefix}/bots`) return jsonAnswer(200, { bots: seededBots });
    if (organizationPath === `${userPrefix}/channels`) return jsonAnswer(200, { channels: seededChannels });
    if (organizationPath === `${userPrefix}/tasks`) return jsonAnswer(200, { tasks: seededTasks });
    if (organizationPath === `${userPrefix}/computer`) return jsonAnswer(200, seededComputer);

    const channelMatch = /^\/channels\/([^/]+)\/(messages|turn|turns\/latest)$/.exec(organizationPath);
    if (channelMatch) {
      const channelId = decodeURIComponent(channelMatch[1]);
      if (channelMatch[2] === "messages") return jsonAnswer(200, { messages: seededMessagesByChannel[channelId] ?? [] });
      if (channelMatch[2] === "turn") return jsonAnswer(404, { detail: "No active turn." });
      const latestTurn = latestTurnByChannel[channelId];
      return latestTurn ? jsonAnswer(200, latestTurn) : jsonAnswer(404, { detail: "No turn yet." });
    }

    const taskMatch = /^\/tasks\/([^/]+)$/.exec(organizationPath);
    if (taskMatch) {
      const task = seededTasks.find((candidate) => candidate.task_id === decodeURIComponent(taskMatch[1]));
      return task ? jsonAnswer(200, task) : jsonAnswer(404, { detail: "No such task." });
    }
    return null;
  }
}
