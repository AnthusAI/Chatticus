import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MeResponse } from "../lib/me";
import type { VerifiedSession } from "../lib/auth";
import {
  membershipViewText,
  resolveMembershipView,
  CROSS_ACCOUNT_SELF_SETUP_FORM_TITLE,
} from "../lib/membership-view";
import { deriveMembershipBranch } from "../lib/membership-state";
import { membershipVisibleText } from "../lib/organization-membership";
import { parseSignupMode } from "../lib/signup-mode";
import {
  CREATE_BOT_FORM_TITLE,
  createBotConfirmationText,
} from "../lib/create-bot";
import { inviteConfirmationText } from "../lib/invitations";
import { orgApiPath } from "../lib/paths";
import {
  grantTableToPayload,
  isTurnGrantPanelVisible,
  TURN_GRANT_FORM_TITLE,
  turnGrantConfirmationText,
} from "../lib/turn-grant";

const statePath =
  process.env.CHATTICUS_MEMBERSHIP_UI_HARNESS_STATE ??
  join(tmpdir(), "chatticus-membership-ui-harness-state.json");

type HarnessState = {
  signupMode: string;
  email: string | null;
  idToken: string | null;
  me: MeResponse | null;
  apiBase: string | null;
  view: string | null;
  visibleText: string | null;
  inviteConfirmation: string | null;
  selfSetupError: string | null;
  workspaceBotNames: string[];
  createBotError: string | null;
  createBotConfirmation: string | null;
  createBotBlocked: boolean;
  activeTurnId: string | null;
  turnStatus: "active" | "completed" | "failed" | "reconciling" | null;
  turnGrantFormVisible: boolean;
  turnGrantConfirmation: string | null;
  turnGrantError: string | null;
  turnGrantBlocked: boolean;
  lastSubmittedTools: string[];
  lastGrantTable: Record<string, string> | null;
  workspaceBotId: string | null;
  workspaceChannelId: string | null;
  turnGrantHttpStatus: number | null;
};

function emptyState(): HarnessState {
  return {
    signupMode: "invitation_only",
    email: null,
    idToken: null,
    me: null,
    apiBase: null,
    view: null,
    visibleText: null,
    inviteConfirmation: null,
    selfSetupError: null,
    workspaceBotNames: [],
    createBotError: null,
    createBotConfirmation: null,
    createBotBlocked: false,
    activeTurnId: null,
    turnStatus: null,
    turnGrantFormVisible: false,
    turnGrantConfirmation: null,
    turnGrantError: null,
    turnGrantBlocked: false,
    lastSubmittedTools: [],
    lastGrantTable: null,
    workspaceBotId: null,
    workspaceChannelId: null,
    turnGrantHttpStatus: null,
  };
}

function loadState(): HarnessState {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as HarnessState;
  } catch {
    return emptyState();
  }
}

function saveState(state: HarnessState): HarnessState {
  writeFileSync(statePath, JSON.stringify(state));
  return state;
}

function clearStateFile(): void {
  try {
    unlinkSync(statePath);
  } catch {
    // no prior state
  }
}

function sessionPresent(email: string): VerifiedSession {
  return {
    email,
    idToken: "harness-token",
    claims: {},
  };
}

function membershipVisibleTextForHarness(
  viewText: string,
  organizations: MeResponse["organizations"],
  extraText: string | null,
): string {
  const base = membershipVisibleText(viewText, organizations);
  if (!extraText) {
    return base;
  }
  return `${base}\n\n${extraText}`;
}

function renderFromMe(state: HarnessState): HarnessState {
  const me = state.me;
  const branch = deriveMembershipBranch(
    state.email ? sessionPresent(state.email) : null,
    me,
  );
  const view = resolveMembershipView(branch, parseSignupMode(state.signupMode));
  state.view = view;
  const extraText =
    view === "welcome"
      ? [CROSS_ACCOUNT_SELF_SETUP_FORM_TITLE, state.selfSetupError]
          .filter(Boolean)
          .join("\n")
      : view === "enabled-workspace"
        ? [CREATE_BOT_FORM_TITLE, state.turnGrantFormVisible ? TURN_GRANT_FORM_TITLE : null]
            .filter(Boolean)
            .join("\n")
        : state.selfSetupError;
  state.visibleText = membershipVisibleTextForHarness(
    membershipViewText(view),
    me?.organizations ?? [],
    extraText,
  );
  return state;
}

function resetHarness(payload: { signup_mode?: string }): HarnessState {
  clearStateFile();
  const state = emptyState();
  state.signupMode = payload.signup_mode ?? "invitation_only";
  process.env.NEXT_PUBLIC_CHATTICUS_SIGNUP_MODE = state.signupMode;
  return saveState(state);
}

function seedSession(payload: { email?: string; id_token?: string }): HarnessState {
  const state = loadState();
  state.email = payload.email ?? "sam@example.com";
  state.idToken = payload.id_token ?? "harness-token";
  return saveState(renderFromMe(state));
}

function setMeEmpty(): HarnessState {
  const state = loadState();
  state.me = {
    email: state.email ?? "sam@example.com",
    user_id: state.email ? "user-1" : null,
    organizations: [],
  };
  return saveState(renderFromMe(state));
}

function renderShell(): HarnessState {
  const state = loadState();
  if (!state.me && state.email) {
    state.me = {
      email: state.email,
      user_id: "user-1",
      organizations: [],
    };
  }
  return saveState(renderFromMe(state));
}

async function submitOrganization(payload: {
  name?: string;
  api_base?: string;
  id_token?: string;
}): Promise<HarnessState> {
  const state = loadState();
  const apiBase = payload.api_base ?? state.apiBase;
  const idToken = payload.id_token ?? state.idToken;
  if (!apiBase || !idToken) {
    throw new Error("api_base and id_token are required to submit an organization");
  }
  const response = await fetch(`${apiBase}/organizations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: payload.name ?? "Acme Labs" }),
  });
  if (!response.ok) {
    throw new Error(`create organization failed: ${response.status} ${await response.text()}`);
  }
  const created = (await response.json()) as {
    tenant_id: string;
    name: string;
    status: string;
  };
  state.me = {
    email: state.email ?? "sam@example.com",
    user_id: "user-1",
    organizations: [
      {
        tenant_id: created.tenant_id,
        name: created.name,
        status: created.status as "pending",
      },
    ],
  };
  return saveState(renderFromMe(state));
}

function setMeEnabled(payload: { tenant_id: string; name: string }): HarnessState {
  const state = loadState();
  if (!state.email) {
    throw new Error("seed a session before setting enabled membership");
  }
  clearWorkspaceBotState(state);
  state.me = {
    email: state.email,
    user_id: "user-1",
    organizations: [
      {
        tenant_id: payload.tenant_id,
        name: payload.name,
        status: "enabled",
      },
    ],
  };
  return saveState(renderFromMe(state));
}

async function submitInvitation(payload: {
  api_base?: string;
  id_token?: string;
  tenant_id: string;
  email: string;
}): Promise<HarnessState> {
  const state = loadState();
  const apiBase = payload.api_base ?? state.apiBase;
  const idToken = payload.id_token ?? state.idToken;
  if (!apiBase || !idToken) {
    throw new Error("api_base and id_token are required to submit an invitation");
  }
  const response = await fetch(`${apiBase}/orgs/${payload.tenant_id}/invitations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: payload.email }),
  });
  if (!response.ok) {
    throw new Error(`invite member failed: ${response.status} ${await response.text()}`);
  }
  const created = (await response.json()) as { email: string };
  state.apiBase = apiBase;
  state.idToken = idToken;
  state.inviteConfirmation = inviteConfirmationText(created.email);
  state.visibleText = state.inviteConfirmation;
  return saveState(state);
}

async function refreshMeFromApi(payload: {
  api_base?: string;
  id_token?: string;
  email?: string;
}): Promise<HarnessState> {
  const state = loadState();
  const apiBase = payload.api_base ?? state.apiBase;
  const idToken = payload.id_token ?? state.idToken;
  if (!apiBase || !idToken) {
    throw new Error("api_base and id_token are required to refresh membership");
  }
  const response = await fetch(`${apiBase}/me`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!response.ok) {
    throw new Error(`GET /me failed: ${response.status} ${await response.text()}`);
  }
  state.me = (await response.json()) as MeResponse;
  state.email = payload.email ?? state.me.email;
  state.apiBase = apiBase;
  state.idToken = idToken;
  clearWorkspaceBotState(state);
  return saveState(renderFromMe(state));
}

async function submitCrossAccountSelfSetup(payload: {
  api_base?: string;
  id_token?: string;
  account_id?: string;
  cross_account_role?: string;
}): Promise<HarnessState> {
  const state = loadState();
  const apiBase = payload.api_base ?? state.apiBase;
  const idToken = payload.id_token ?? state.idToken;
  const organization = state.me?.organizations?.[0];
  if (!apiBase || !idToken || !organization) {
    throw new Error("api_base, id_token, and a pending organization are required");
  }
  const response = await fetch(
    `${apiBase}/orgs/${organization.tenant_id}/self-setup/cross-account-role`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        account_id: payload.account_id ?? "123456789012",
        cross_account_role:
          payload.cross_account_role ??
          "arn:aws:iam::123456789012:role/ChatticusOrganizationComputerRole",
      }),
    },
  );
  if (!response.ok) {
    let detail = await response.text();
    try {
      const parsed = JSON.parse(detail) as { detail?: string };
      if (parsed.detail) {
        detail = parsed.detail;
      }
    } catch {
      // keep raw body
    }
    state.selfSetupError = detail;
    return saveState(renderFromMe(state));
  }
  state.selfSetupError = null;
  const accepted = (await response.json()) as {
    tenant_id: string;
    name: string;
    status: string;
  };
  if (state.me) {
    state.me = {
      ...state.me,
      organizations: state.me.organizations.map((row) =>
        row.tenant_id === accepted.tenant_id
          ? { ...row, status: accepted.status as "enabled" }
          : row,
      ),
    };
  }
  return saveState(renderFromMe(state));
}

function clearWorkspaceBotState(state: HarnessState): HarnessState {
  state.workspaceBotNames = [];
  state.createBotError = null;
  state.createBotConfirmation = null;
  state.createBotBlocked = false;
  clearTurnGrantState(state);
  return state;
}

function clearTurnGrantState(state: HarnessState): HarnessState {
  state.activeTurnId = null;
  state.turnStatus = null;
  state.turnGrantFormVisible = false;
  state.turnGrantConfirmation = null;
  state.turnGrantError = null;
  state.turnGrantBlocked = false;
  state.lastSubmittedTools = [];
  state.lastGrantTable = null;
  state.workspaceBotId = null;
  state.workspaceChannelId = null;
  state.turnGrantHttpStatus = null;
  return state;
}

function enabledOrganization(state: HarnessState) {
  return state.me?.organizations?.find((row) => row.status === "enabled");
}

async function resolveApiContext(
  state: HarnessState,
  payload: {
    api_base?: string;
    id_token?: string;
    tenant_id?: string;
  },
): Promise<{ apiBase: string; idToken: string; tenantId: string; userId: string }> {
  const apiBase = payload.api_base ?? state.apiBase;
  const idToken = payload.id_token ?? state.idToken;
  const organization = enabledOrganization(state);
  const tenantId = payload.tenant_id ?? organization?.tenant_id;
  const userId = state.me?.user_id;
  if (!apiBase || !idToken || !tenantId || !userId) {
    throw new Error("api_base, id_token, enabled tenant, and user_id are required");
  }
  return { apiBase, idToken, tenantId, userId };
}

async function refreshWorkspaceBots(
  state: HarnessState,
  payload: {
    api_base?: string;
    id_token?: string;
    tenant_id?: string;
  },
): Promise<void> {
  const apiBase = payload.api_base ?? state.apiBase;
  const idToken = payload.id_token ?? state.idToken;
  const organization = state.me?.organizations?.find(
    (row) => row.status === "enabled",
  );
  const tenantId = payload.tenant_id ?? organization?.tenant_id;
  if (!apiBase || !idToken || !tenantId || !state.me?.user_id) {
    throw new Error("api_base, id_token, enabled tenant, and user_id are required");
  }
  const response = await fetch(
    `${apiBase}${orgApiPath(tenantId, `/users/${encodeURIComponent(state.me.user_id)}/bots`)}`,
    { headers: { Authorization: `Bearer ${idToken}` } },
  );
  if (!response.ok) {
    throw new Error(`list bots failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { bots: Array<{ name: string }> };
  state.workspaceBotNames = body.bots.map((bot) => bot.name);
  state.apiBase = apiBase;
  state.idToken = idToken;
}

async function loadWorkspaceBots(payload: {
  api_base?: string;
  id_token?: string;
  tenant_id?: string;
}): Promise<HarnessState> {
  const state = loadState();
  await refreshWorkspaceBots(state, payload);
  return saveState(renderFromMe(state));
}

async function submitCreateBot(payload: {
  api_base?: string;
  id_token?: string;
  tenant_id?: string;
  name?: string;
}): Promise<HarnessState> {
  const state = loadState();
  const apiBase = payload.api_base ?? state.apiBase;
  const idToken = payload.id_token ?? state.idToken;
  const organization = state.me?.organizations?.find(
    (row) => row.status === "enabled",
  );
  const tenantId = payload.tenant_id ?? organization?.tenant_id;
  const trimmed = (payload.name ?? "").trim();
  state.createBotError = null;
  state.createBotConfirmation = null;
  state.createBotBlocked = false;
  if (!trimmed) {
    state.createBotBlocked = true;
    return saveState(renderFromMe(state));
  }
  if (!apiBase || !idToken || !tenantId) {
    throw new Error("api_base, id_token, and enabled tenant are required");
  }
  const response = await fetch(`${apiBase}${orgApiPath(tenantId, "/bots")}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ name: trimmed }),
  });
  if (!response.ok) {
    let detail = await response.text();
    try {
      const parsed = JSON.parse(detail) as { detail?: string };
      if (parsed.detail) {
        detail = parsed.detail;
      }
    } catch {
      // keep raw body
    }
    state.createBotError = detail;
    await refreshWorkspaceBots(state, {
      api_base: apiBase,
      id_token: idToken,
      tenant_id: tenantId,
    });
    return saveState(renderFromMe(state));
  }
  const created = (await response.json()) as { name: string };
  state.createBotConfirmation = createBotConfirmationText(created.name);
  state.apiBase = apiBase;
  state.idToken = idToken;
  await refreshWorkspaceBots(state, {
    api_base: apiBase,
    id_token: idToken,
    tenant_id: tenantId,
  });
  return saveState(renderFromMe(state));
}

async function setupActiveTurn(payload: {
  api_base?: string;
  id_token?: string;
  tenant_id?: string;
  bot_name?: string;
  message?: string;
}): Promise<HarnessState> {
  let state = loadState();
  state = await refreshMeFromApi({
    api_base: payload.api_base,
    id_token: payload.id_token,
    email: state.email ?? undefined,
  });
  const botName = payload.bot_name ?? "Researcher";
  state = await submitCreateBot({
    api_base: payload.api_base,
    id_token: payload.id_token,
    tenant_id: payload.tenant_id,
    name: botName,
  });
  const { apiBase, idToken, tenantId, userId } = await resolveApiContext(state, payload);
  const botsResponse = await fetch(
    `${apiBase}${orgApiPath(tenantId, `/users/${encodeURIComponent(userId)}/bots`)}`,
    { headers: { Authorization: `Bearer ${idToken}` } },
  );
  if (!botsResponse.ok) {
    throw new Error(`list bots failed: ${botsResponse.status} ${await botsResponse.text()}`);
  }
  const botsBody = (await botsResponse.json()) as {
    bots: Array<{ bot_id: string; name: string }>;
  };
  const bot = botsBody.bots.find((candidate) => candidate.name === botName);
  if (!bot) {
    throw new Error(`bot ${JSON.stringify(botName)} not found after create`);
  }
  const channelResponse = await fetch(`${apiBase}${orgApiPath(tenantId, "/channels")}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user_id: userId, bot_ids: [bot.bot_id] }),
  });
  if (!channelResponse.ok) {
    throw new Error(
      `create channel failed: ${channelResponse.status} ${await channelResponse.text()}`,
    );
  }
  const channel = (await channelResponse.json()) as { channel_id: string };
  const messageResponse = await fetch(
    `${apiBase}${orgApiPath(tenantId, `/channels/${encodeURIComponent(channel.channel_id)}/messages`)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        author_kind: "human",
        author_id: userId,
        body: payload.message ?? "hello Researcher",
        addressed_to_bot_id: bot.bot_id,
      }),
    },
  );
  if (!messageResponse.ok) {
    throw new Error(`post message failed: ${messageResponse.status} ${await messageResponse.text()}`);
  }
  const posted = (await messageResponse.json()) as { turn_id: string | null };
  if (!posted.turn_id) {
    throw new Error("post message did not start a turn");
  }
  state.workspaceBotId = bot.bot_id;
  state.workspaceChannelId = channel.channel_id;
  state.activeTurnId = posted.turn_id;
  state.turnStatus = "active";
  state.turnGrantFormVisible = isTurnGrantPanelVisible(posted.turn_id, "active");
  state.turnGrantConfirmation = null;
  state.turnGrantError = null;
  state.turnGrantBlocked = false;
  state.apiBase = apiBase;
  state.idToken = idToken;
  return saveState(renderFromMe(state));
}

function grantTableFromPayload(payload: Record<string, string>): Record<string, string> {
  const table: Record<string, string> = {};
  for (const field of [
    "tools",
    "origins",
    "recipients",
    "file_scopes",
    "egress_classes",
    "ingest_classes",
  ]) {
    if (payload[field] !== undefined) {
      table[field] = payload[field];
    }
  }
  return table;
}

async function submitTurnGrant(payload: Record<string, string>): Promise<HarnessState> {
  const state = loadState();
  const { apiBase, idToken, tenantId } = await resolveApiContext(state, payload);
  const turnId = state.activeTurnId;
  if (!turnId) {
    throw new Error("active turn is required to replace a grant");
  }
  state.turnGrantConfirmation = null;
  state.turnGrantError = null;
  state.turnGrantBlocked = false;
  const table = grantTableFromPayload(payload);
  if (payload.run_terminal === "true") {
    const tools = (table.tools ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (!tools.includes("run_terminal")) {
      tools.push("run_terminal");
    }
    table.tools = tools.join(", ");
  }
  state.lastGrantTable = table;
  const grantPayload = grantTableToPayload(table);
  if (grantPayload.tools.length === 0) {
    state.turnGrantBlocked = true;
    return saveState(renderFromMe(state));
  }
  const response = await fetch(
    `${apiBase}${orgApiPath(tenantId, `/turns/${encodeURIComponent(turnId)}/grant`)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(grantPayload),
    },
  );
  if (!response.ok) {
    let detail = await response.text();
    try {
      const parsed = JSON.parse(detail) as { detail?: string };
      if (parsed.detail) {
        detail = parsed.detail;
      }
    } catch {
      // keep raw body
    }
    state.turnGrantError = detail;
    return saveState(renderFromMe(state));
  }
  const replaced = (await response.json()) as { tools: string[] };
  state.lastSubmittedTools = replaced.tools;
  state.turnGrantConfirmation = turnGrantConfirmationText(replaced.tools);
  state.apiBase = apiBase;
  state.idToken = idToken;
  return saveState(renderFromMe(state));
}

async function submitTurnGrantBeyondStanding(payload: Record<string, string>): Promise<HarnessState> {
  return submitTurnGrant({
    ...payload,
    tools: "read_workspace, browse",
    origins: "https://docs.example.com",
    recipients: "",
    file_scopes: "/workspace",
    egress_classes: "approved_origin_fetch",
  });
}

async function trySubmitEmptyTurnGrant(payload: Record<string, string>): Promise<HarnessState> {
  const state = loadState();
  state.turnGrantConfirmation = null;
  state.turnGrantError = null;
  state.turnGrantBlocked = false;
  if (!state.activeTurnId) {
    state.turnGrantBlocked = true;
    return saveState(renderFromMe(state));
  }
  return submitTurnGrant({
    ...payload,
    tools: "",
    origins: "",
    recipients: "",
    file_scopes: "",
    egress_classes: "",
  });
}

async function putTurnGrantHttp(payload: Record<string, string>): Promise<HarnessState> {
  const state = loadState();
  const { apiBase, idToken, tenantId } = await resolveApiContext(state, payload);
  const turnId = state.activeTurnId;
  if (!turnId) {
    throw new Error("active turn is required");
  }
  const response = await fetch(
    `${apiBase}${orgApiPath(tenantId, `/turns/${encodeURIComponent(turnId)}/grant`)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tools: [],
        origins: [],
        recipients: [],
        file_scopes: [],
        egress_classes: [],
        ingest_classes: [],
      }),
    },
  );
  state.turnGrantHttpStatus = response.status;
  return saveState(state);
}

async function main(): Promise<void> {
  const [command, payloadJson] = process.argv.slice(2);
  const payload = JSON.parse(payloadJson ?? "{}") as Record<string, string>;
  let result: HarnessState;

  switch (command) {
    case "reset":
      result = resetHarness(payload);
      break;
    case "seed-session":
      result = seedSession(payload);
      break;
    case "set-me-empty":
      result = setMeEmpty();
      break;
    case "render-shell":
      result = renderShell();
      break;
    case "submit-organization":
      result = await submitOrganization(payload);
      break;
    case "set-me-enabled":
      result = setMeEnabled(payload as { tenant_id: string; name: string });
      break;
    case "submit-invitation":
      result = await submitInvitation(
        payload as {
          api_base?: string;
          id_token?: string;
          tenant_id: string;
          email: string;
        },
      );
      break;
    case "refresh-me-from-api":
      result = await refreshMeFromApi(payload);
      break;
    case "submit-cross-account-self-setup":
      result = await submitCrossAccountSelfSetup(payload);
      break;
    case "load-workspace-bots":
      result = await loadWorkspaceBots(payload);
      break;
    case "submit-create-bot":
      result = await submitCreateBot(payload);
      break;
    case "setup-active-turn":
      result = await setupActiveTurn(payload);
      break;
    case "submit-turn-grant":
      result = await submitTurnGrant(payload);
      break;
    case "submit-turn-grant-beyond-standing":
      result = await submitTurnGrantBeyondStanding(payload);
      break;
    case "try-submit-empty-turn-grant":
      result = await trySubmitEmptyTurnGrant(payload);
      break;
    case "put-turn-grant-http":
      result = await putTurnGrantHttp(payload);
      break;
    default:
      throw new Error(`Unknown membership UI harness command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main();
