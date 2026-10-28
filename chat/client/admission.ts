import type { Message } from "./protocol";
import type { ChatHttpTransport } from "./transport";

/** Existing human-message wire contract; the server verifies the claimed author. */
export type ChatMessageSubmission = {
  author_kind: "human";
  author_id: string;
  body: string;
  addressed_to_bot_id: string | null;
};

export type PostMessageResponse = {
  message: Message;
  turn_id: string | null;
};

/**
 * Admit one logical submission. The host retains the same key and body when
 * retrying an uncertain response; a new message needs a new key. No automatic
 * retry, credential cache or anonymous fallback is provided here.
 */
export async function postChatMessage(transport: ChatHttpTransport, submission: ChatMessageSubmission, idempotencyKey: string): Promise<PostMessageResponse> {
  if (!idempotencyKey.trim()) throw new Error("A stable message admission key is required");
  const headers = new Headers(await transport.headers());
  headers.set("Content-Type", "application/json");
  headers.set("Idempotency-Key", idempotencyKey);
  const response = await (transport.fetch ?? fetch)(transport.url, {
    method: "POST",
    headers,
    body: JSON.stringify(submission),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as PostMessageResponse;
}
