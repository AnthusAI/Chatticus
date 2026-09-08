import { apiBase } from "./config";
import { authorizedHeaders } from "./api-auth";
import { orgApiPath } from "./paths";
import type { ActiveOrg } from "./membership-state";

export type HealthResponse = {
  environment?: string;
  status?: string;
};

export type Bot = {
  bot_id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  memory: Record<string, string>;
};

export type Channel = {
  channel_id: string;
  tenant_id: string;
  user_id: string;
};

export type PostMessageResponse = {
  message_id: string;
  turn_id: string | null;
  seq: number;
};

export type TurnEvent = {
  kind: string;
  seq: number;
  turn_id: string;
  token?: string;
  body?: string;
};

export type Task = {
  task_id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  status: string;
  evidence: string | null;
  close_reason: string | null;
  created_by_bot_id: string | null;
  updated_by_bot_id: string | null;
};

export type TurnGrantPayload = {
  tools: string[];
  origins: string[];
  recipients: string[];
  file_scopes: string[];
  egress_classes: string[];
  ingest_classes: string[];
};

export type ReplaceTurnGrantResponse = {
  turn_id: string;
  tools: string[];
};

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }
  return (await response.json()) as T;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch(`${apiBase}/health`);
  return readJson<HealthResponse>(response);
}

export async function listBots(org: ActiveOrg): Promise<Bot[]> {
  const response = await fetch(
    `${apiBase}${orgApiPath(org.tenantId, `/users/${encodeURIComponent(org.userId)}/bots`)}`,
    { headers: await authorizedHeaders() },
  );
  const body = await readJson<{ bots: Bot[] }>(response);
  return body.bots;
}

export async function createBot(org: ActiveOrg, name: string): Promise<Bot> {
  const response = await fetch(`${apiBase}${orgApiPath(org.tenantId, "/bots")}`, {
    method: "POST",
    headers: await authorizedHeaders({
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    }),
    body: JSON.stringify({ name: name.trim() }),
  });
  return readJson<Bot>(response);
}

export async function createChannel(
  org: ActiveOrg,
  botIds: string[],
): Promise<Channel> {
  const response = await fetch(`${apiBase}${orgApiPath(org.tenantId, "/channels")}`, {
    method: "POST",
    headers: await authorizedHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ user_id: org.userId, bot_ids: botIds }),
  });
  return readJson<Channel>(response);
}

export async function postMessage(
  org: ActiveOrg,
  channelId: string,
  body: string,
  addressedToBotId: string,
): Promise<PostMessageResponse> {
  const response = await fetch(
    `${apiBase}${orgApiPath(org.tenantId, `/channels/${encodeURIComponent(channelId)}/messages`)}`,
    {
      method: "POST",
      headers: await authorizedHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        author_kind: "human",
        author_id: org.userId,
        body,
        addressed_to_bot_id: addressedToBotId,
      }),
    },
  );
  return readJson<PostMessageResponse>(response);
}

export async function listTasks(org: ActiveOrg): Promise<Task[]> {
  const response = await fetch(
    `${apiBase}${orgApiPath(org.tenantId, `/users/${encodeURIComponent(org.userId)}/tasks`)}`,
    { headers: await authorizedHeaders() },
  );
  const body = await readJson<{ tasks: Task[] }>(response);
  return body.tasks;
}

export async function getTask(org: ActiveOrg, taskId: string): Promise<Task> {
  const response = await fetch(
    `${apiBase}${orgApiPath(org.tenantId, `/tasks/${encodeURIComponent(taskId)}`)}`,
    { headers: await authorizedHeaders() },
  );
  return readJson<Task>(response);
}

export async function replaceTurnGrant(
  org: ActiveOrg,
  turnId: string,
  payload: TurnGrantPayload,
): Promise<ReplaceTurnGrantResponse> {
  const response = await fetch(
    `${apiBase}${orgApiPath(org.tenantId, `/turns/${encodeURIComponent(turnId)}/grant`)}`,
    {
      method: "PUT",
      headers: await authorizedHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(payload),
    },
  );
  return readJson<ReplaceTurnGrantResponse>(response);
}
