import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MeResponse } from "../lib/me";
import {
  membershipViewText,
  resolveMembershipView,
  welcomeScreenText,
} from "../lib/membership-view";
import { deriveMembershipBranch } from "../lib/membership-state";
import { parseSignupMode } from "../lib/signup-mode";
import { inviteConfirmationText } from "../lib/invitations";

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

function sessionPresent(email: string) {
  return {
    email,
    id_token: "harness-token",
    expires_at: 4_000_000_000,
  };
}

function renderFromMe(state: HarnessState): HarnessState {
  const me = state.me;
  const branch = deriveMembershipBranch(
    state.email ? sessionPresent(state.email) : null,
    me,
  );
  const view = resolveMembershipView(branch, parseSignupMode(state.signupMode));
  state.view = view;
  state.visibleText = membershipViewText(view);
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
    status: string;
  };
  state.me = {
    email: state.email ?? "sam@example.com",
    user_id: "user-1",
    organizations: [{ tenant_id: created.tenant_id, status: created.status as "pending" }],
  };
  state.view = "welcome";
  state.visibleText = welcomeScreenText();
  return saveState(renderFromMe(state));
}

function setMeEnabled(payload: { tenant_id: string }): HarnessState {
  const state = loadState();
  if (!state.email) {
    throw new Error("seed a session before setting enabled membership");
  }
  state.me = {
    email: state.email,
    user_id: "user-1",
    organizations: [{ tenant_id: payload.tenant_id, status: "enabled" }],
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
  return saveState(renderFromMe(state));
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
      result = setMeEnabled(payload as { tenant_id: string });
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
    default:
      throw new Error(`Unknown membership UI harness command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main();
