import type {
  ChannelCostResponse,
  CostRowsResponse,
  CostSummaryResponse,
  TurnCostResponse,
} from "@chatticus/host-protocol/costs";

import { authorizedHeaders } from "./api-auth";
import { apiBase } from "./config";
import type { ActiveOrg } from "./membership-state";
import { orgApiPath } from "./paths";

/** The filters and paging the list and rollup routes take. */
export type CostsQuery = {
  from?: string;
  to?: string;
  botId?: string;
  channelId?: string;
  memberId?: string;
  groupBy?: "bot" | "channel" | "member" | "model" | "day" | "month";
  limit?: number;
  cursor?: string;
};

/** Which export a person asked for. */
export type CostsExportGrain = "turn" | "call";

/** A file the browser can be handed. */
export type CostsDownload = { filename: string; mimeType: string; text: string };

/** A cost route answered with an error. `code` is the API's error code when it sent one. */
export class CostsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "CostsApiError";
  }
}

/** The cost routes, as the controller uses them. */
export type CostsApi = {
  summary: (query: CostsQuery) => Promise<CostSummaryResponse>;
  turns: (query: CostsQuery) => Promise<CostRowsResponse>;
  channelCost: (channelId: string, query: CostsQuery) => Promise<ChannelCostResponse>;
  turnCost: (turnId: string) => Promise<TurnCostResponse>;
  exportCosts: (query: CostsQuery, grain: CostsExportGrain) => Promise<CostsDownload>;
};

function queryString(query: CostsQuery): string {
  const params = new URLSearchParams();
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.botId) params.set("bot_id", query.botId);
  if (query.channelId) params.set("channel_id", query.channelId);
  if (query.memberId) params.set("member_id", query.memberId);
  if (query.groupBy) params.set("group_by", query.groupBy);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

async function failureOf(response: Response): Promise<CostsApiError> {
  let code: string | null = null;
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown; detail?: unknown };
    if (typeof body.error === "string") code = body.error;
    if (typeof body.message === "string") message = body.message;
    else if (typeof body.detail === "string") message = body.detail;
  } catch {
    message = `HTTP ${response.status}`;
  }
  return new CostsApiError(response.status, code, message);
}

async function readCostsJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw await failureOf(response);
  return (await response.json()) as T;
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  const match = header === null ? null : /filename="([^"\\/]+)"/.exec(header);
  return match ? match[1] : fallback;
}

/** The cost routes of one organization, called as the signed-in member. */
export function costsApiFor(org: ActiveOrg): CostsApi {
  const url = (suffix: string) => `${apiBase}${orgApiPath(org.tenantId, suffix)}`;
  const getJson = async <T>(suffix: string): Promise<T> =>
    readCostsJson<T>(await fetch(url(suffix), { headers: await authorizedHeaders() }));
  return {
    summary: (query) => getJson<CostSummaryResponse>(`/costs${queryString(query)}`),
    turns: (query) => getJson<CostRowsResponse>(`/costs/turns${queryString(query)}`),
    channelCost: (channelId, query) =>
      getJson<ChannelCostResponse>(`/channels/${encodeURIComponent(channelId)}/cost${queryString(query)}`),
    turnCost: (turnId) => getJson<TurnCostResponse>(`/turns/${encodeURIComponent(turnId)}/cost`),
    exportCosts: async (query, grain) => {
      const params = new URLSearchParams(queryString(query).slice(1));
      params.set("format", "csv");
      params.set("grain", grain);
      const response = await fetch(url(`/costs/export?${params.toString()}`), { headers: await authorizedHeaders() });
      if (!response.ok) throw await failureOf(response);
      return {
        filename: filenameFromDisposition(response.headers.get("Content-Disposition"), `costs-${grain}.csv`),
        mimeType: "text/csv",
        text: await response.text(),
      };
    },
  };
}
