import { apiBase, tenantId } from "./config";
import { orgApiPath } from "./paths";

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

export async function listBots(userId: string): Promise<Bot[]> {
  const response = await fetch(
    `${apiBase}${orgApiPath(tenantId, `/users/${encodeURIComponent(userId)}/bots`)}`,
  );
  const body = await readJson<{ bots: Bot[] }>(response);
  return body.bots;
}

export async function createChannel(
  userId: string,
  botIds: string[],
): Promise<Channel> {
  const response = await fetch(`${apiBase}${orgApiPath(tenantId, "/channels")}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user_id: userId, bot_ids: botIds }),
  });
  return readJson<Channel>(response);
}

export async function postMessage(
  channelId: string,
  userId: string,
  body: string,
  addressedToBotId: string,
): Promise<PostMessageResponse> {
  const response = await fetch(
    `${apiBase}${orgApiPath(tenantId, `/channels/${encodeURIComponent(channelId)}/messages`)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        author_kind: "human",
        author_id: userId,
        body,
        addressed_to_bot_id: addressedToBotId,
      }),
    },
  );
  return readJson<PostMessageResponse>(response);
}

export async function listTasks(userId: string): Promise<Task[]> {
  const response = await fetch(
    `${apiBase}${orgApiPath(tenantId, `/users/${encodeURIComponent(userId)}/tasks`)}`,
  );
  const body = await readJson<{ tasks: Task[] }>(response);
  return body.tasks;
}

export async function getTask(taskId: string): Promise<Task> {
  const response = await fetch(
    `${apiBase}${orgApiPath(tenantId, `/tasks/${encodeURIComponent(taskId)}`)}`,
  );
  return readJson<Task>(response);
}
