import { openTurnEventStream, type TurnStreamHandlers } from "../../chat/client";
import { apiBase } from "./config";
import { authorizedHeaders } from "./api-auth";
import { orgApiPath } from "./paths";
export type { TurnStreamHandlers } from "../../chat/client";

/** Open the host's authenticated org-scoped observer with shared stream behavior. */
export function openTurnStream(tenantId: string, turnId: string, handlers: TurnStreamHandlers, lastEventId?: number): () => void {
  return openTurnEventStream({
    url: `${apiBase}${orgApiPath(tenantId, `/turns/${encodeURIComponent(turnId)}/stream`)}`,
    headers: () => authorizedHeaders(),
  }, handlers, lastEventId);
}
