import { authorizedHeaders } from "./api-auth";
import { apiBase } from "./config";
import type { ActiveOrg } from "./membership-state";
import { orgApiPath } from "./paths";

/** One comment on a card, as the front door returns the Kanbus issue. */
export type BotBoardComment = {
  id?: string;
  author: string;
  text?: string;
  created_at: string;
  comment_type?: string;
  data?: Record<string, unknown>;
};

/** One dependency link on a card. */
export type BotBoardDependency = { target: string; type: string };

/** The Kanbus issue JSON the front door returns for a card, unchanged. Absent and null fields are both possible. */
export type BotBoardIssue = {
  id: string;
  title: string;
  type: string;
  status: string;
  priority: number;
  description?: string;
  assignee?: string | null;
  creator?: string;
  parent?: string | null;
  labels?: string[];
  dependencies?: BotBoardDependency[];
  comments?: BotBoardComment[];
  custom?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
};

/** A card with the revision the store holds. */
export type BotBoardCard = { issue: BotBoardIssue; revision: string; project?: string };

/**
 * The configuration of a board as Kanbus keeps it. Every field is optional because the front door passes it through
 * as it is; the adapter reads what it needs and leaves out what is missing.
 */
export type BotBoardConfiguration = {
  name?: string;
  hierarchy?: string[];
  types?: string[];
  workflows?: Record<string, Record<string, string[]>>;
  initial_status?: string;
  priorities?: Record<string, unknown>;
  statuses?: unknown[];
  categories?: unknown[];
  sort_order?: Record<string, unknown>;
  type_colors?: Record<string, string>;
};

/** A page of cards. `catalog_pending` is true when the listing may be behind the saved cards. */
export type BotBoardPage = { cards: BotBoardCard[]; next_cursor: string | null; catalog_pending: boolean };

/** The overview of a board: its name, its configuration and the first page of cards. */
export type BotBoardOverview = BotBoardPage & { tenant_id: string; bot_id: string; bot_name: string; configuration: BotBoardConfiguration };

/** A bot board route answered with an error. `code` is the front door's error code; status 0 means no answer arrived. */
export class BotBoardsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "BotBoardsApiError";
  }
}

/** The code the routes answer with where the deployment has no board service. */
export const BOARD_SERVICE_NOT_ENABLED_CODE = "board_service_not_enabled";

/** The read routes of a bot's board, as the controller uses them. */
export type BotBoardsApi = {
  overview: (botId: string, query: { limit: number }) => Promise<BotBoardOverview>;
  cards: (botId: string, query: { limit: number; cursor: string }) => Promise<BotBoardPage>;
};

async function failureOf(response: Response): Promise<BotBoardsApiError> {
  let code: string | null = null;
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { code?: unknown; detail?: unknown };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.detail === "string") message = body.detail;
  } catch {
    message = `HTTP ${response.status}`;
  }
  return new BotBoardsApiError(response.status, code, message);
}

/** The bot board routes of one organization, called as the signed-in member. The panel only reads. */
export function botBoardsApiFor(org: ActiveOrg): BotBoardsApi {
  const boardUrl = (botId: string, suffix: string) => `${apiBase}${orgApiPath(org.tenantId, `/bots/${encodeURIComponent(botId)}/board${suffix}`)}`;
  const getJson = async <T>(url: string): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(url, { headers: await authorizedHeaders() });
    } catch (error) {
      throw new BotBoardsApiError(0, null, error instanceof Error ? error.message : "The request did not complete");
    }
    if (!response.ok) throw await failureOf(response);
    return (await response.json()) as T;
  };
  return {
    overview: (botId, query) => getJson<BotBoardOverview>(boardUrl(botId, `?limit=${query.limit}`)),
    cards: (botId, query) => getJson<BotBoardPage>(boardUrl(botId, `/cards?limit=${query.limit}&cursor=${encodeURIComponent(query.cursor)}`)),
  };
}
