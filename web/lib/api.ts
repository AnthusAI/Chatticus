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
  kind: "direct" | "named";
  name: string | null;
  participants: Array<{ kind: "human" | "bot"; actor_id: string }>;
  next_seq?: number;
};

export type PostMessageResponse = {
  message: Message;
  turn_id: string | null;
};

export type Message = {
  message_id: string;
  channel_id: string;
  tenant_id: string;
  seq: number;
  author_kind: "human" | "bot";
  author_id: string;
  body: string;
  addressed_to_bot_id: string | null;
  created_at: string;
};

export type Turn = {
  turn_id: string;
  tenant_id: string;
  channel_id: string;
  bot_id: string;
  status: "active" | "completed" | "failed" | "reconciling";
  waiting_for: string | null;
  model_id?: string | null;
};

export type ModelOption = {
  model_id: string;
  vendor: string;
  display_name: string;
  billed_via: string;
};

export type ModelsResponse = {
  models: ModelOption[];
  default_model_id: string | null;
};

export type Computer = {
  computer_id: string;
  tenant_id: string;
  stopped: boolean;
  policy: string;
  host_start_generation: number;
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
  name?: string,
): Promise<Channel> {
  const response = await fetch(`${apiBase}${orgApiPath(org.tenantId, "/channels")}`, {
    method: "POST",
    headers: await authorizedHeaders({
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    }),
    body: JSON.stringify({
      user_id: org.userId,
      bot_ids: botIds,
      kind: name ? "named" : "direct",
      name: name?.trim() || null,
    }),
  });
  return readJson<Channel>(response);
}

export async function listChannels(org: ActiveOrg): Promise<Channel[]> {
  const response = await fetch(
    `${apiBase}${orgApiPath(org.tenantId, `/users/${encodeURIComponent(org.userId)}/channels`)}`,
    { headers: await authorizedHeaders() },
  );
  const body = await readJson<{ channels: Channel[] }>(response);
  return body.channels;
}

export async function listMessages(org: ActiveOrg, channelId: string): Promise<Message[]> {
  const response = await fetch(
    `${apiBase}${orgApiPath(org.tenantId, `/channels/${encodeURIComponent(channelId)}/messages`)}`,
    { headers: await authorizedHeaders() },
  );
  const body = await readJson<{ messages: Message[] }>(response);
  return body.messages;
}

export async function getActiveTurn(org: ActiveOrg, channelId: string): Promise<Turn | null> {
  const response = await fetch(
    `${apiBase}${orgApiPath(org.tenantId, `/channels/${encodeURIComponent(channelId)}/turn`)}`,
    { headers: await authorizedHeaders() },
  );
  if (response.status === 404) {
    return null;
  }
  return readJson<Turn>(response);
}

export async function getComputer(org: ActiveOrg): Promise<Computer> {
  const response = await fetch(
    `${apiBase}${orgApiPath(org.tenantId, `/users/${encodeURIComponent(org.userId)}/computer`)}`,
    { headers: await authorizedHeaders() },
  );
  return readJson<Computer>(response);
}

export async function listModels(org: ActiveOrg): Promise<ModelsResponse> {
  const response = await fetch(
    `${apiBase}${orgApiPath(org.tenantId, "/models")}`,
    { headers: await authorizedHeaders() },
  );
  return readJson<ModelsResponse>(response);
}

export async function postMessage(
  org: ActiveOrg,
  channelId: string,
  body: string,
  addressedToBotId: string,
  modelId?: string | null,
): Promise<PostMessageResponse> {
  const payload: Record<string, string> = {
    author_kind: "human",
    author_id: org.userId,
    body,
    addressed_to_bot_id: addressedToBotId,
  };
  if (modelId) {
    payload.model_id = modelId;
  }
  const response = await fetch(
    `${apiBase}${orgApiPath(org.tenantId, `/channels/${encodeURIComponent(channelId)}/messages`)}`,
    {
      method: "POST",
      headers: await authorizedHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(payload),
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
