import { z } from "zod";

/** The most rows one list page returns. */
export const COST_PAGE_MAX_LIMIT = 200;
/** The rows one list page returns when the caller names no limit. */
export const COST_PAGE_DEFAULT_LIMIT = 50;
/** The most groups one rollup page returns. */
export const COST_GROUP_PAGE_MAX_LIMIT = 500;
/** The groups one rollup page returns when the caller names no limit. */
export const COST_GROUP_PAGE_DEFAULT_LIMIT = 100;
/** How many calendar months back the cost routes read, counting the current one. */
export const COST_LOOKBACK_MONTHS = 36;
/** The most turns a call-grain export reads sessions for; a wider range is refused so the caller narrows it. */
export const COST_EXPORT_CALL_GRAIN_MAX_TURNS = 200;
/** The fewest and most subjects one comparison names. */
export const COST_COMPARE_MIN_SUBJECTS = 2;
export const COST_COMPARE_MAX_SUBJECTS = 6;

/** The ways a rollup can group the rows of a date range. */
export const COST_GROUP_BY_VALUES = ["bot", "channel", "member", "model", "day", "month"] as const;
/** What one `group_by` value groups on. */
export type CostGroupBy = (typeof COST_GROUP_BY_VALUES)[number];

/** Every code a cost route answers an error with. */
export const COST_ERROR_CODES = ["invalid_query", "channel_not_found", "turn_not_found", "export_too_large"] as const;
/** The code of one cost route error. */
export type CostErrorCode = (typeof COST_ERROR_CODES)[number];

/** The body of a cost route error. */
export const costErrorBodySchema = z.object({ error: z.enum(COST_ERROR_CODES), message: z.string() });
/** The body of a cost route error. */
export type CostErrorBody = z.infer<typeof costErrorBodySchema>;

const dollars = z.string().regex(/^-?\d+(\.\d+)?$/);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The tokens and dollars of the calls of one model. `priced_cost_usd` is the dollars of the calls that have a price;
 * `unpriced_calls` counts the calls that do not, whose dollars are unknown and are never counted as zero. A model with an
 * unpriced call in one turn has no dollar subtotal in that turn at all, so its priced dollars there are not in the sum.
 */
export const costModelBreakdownSchema = z.object({
	model: z.string(),
	calls: z.number().int().nonnegative(),
	input_tokens: z.number().int().nonnegative(),
	cache_read_tokens: z.number().int().nonnegative(),
	cache_write_tokens: z.number().int().nonnegative(),
	output_tokens: z.number().int().nonnegative(),
	priced_cost_usd: dollars,
	unpriced_calls: z.number().int().nonnegative(),
});
/** The tokens and dollars of the calls of one model. */
export type CostModelBreakdown = z.infer<typeof costModelBreakdownSchema>;

/**
 * The cost of a set of rows, the one shape every level uses (a turn, a message, a channel, a bot, an organization, a
 * month). `priced_cost_usd` adds up exactly across the parts of any grouping. `cost_usd` is that sum when every call was
 * priced, and null when `unpriced_calls` is positive, because the total is then not known; `complete` says which. A row
 * that is still `running`, `yielded` or `parked` is counted in `open_turns` and its figures may still grow.
 */
export const costTotalsSchema = z.object({
	rows: z.number().int().nonnegative(),
	turns: z.number().int().nonnegative(),
	calls: z.number().int().nonnegative(),
	input_tokens: z.number().int().nonnegative(),
	cache_read_tokens: z.number().int().nonnegative(),
	cache_write_tokens: z.number().int().nonnegative(),
	output_tokens: z.number().int().nonnegative(),
	priced_cost_usd: dollars,
	cost_usd: dollars.nullable(),
	unpriced_calls: z.number().int().nonnegative(),
	complete: z.boolean(),
	gateway_rows: z.number().int().nonnegative(),
	estimated_rows: z.number().int().nonnegative(),
	open_turns: z.number().int().nonnegative(),
	price_book_ids: z.array(z.string()),
	by_model: z.array(costModelBreakdownSchema),
});
/** The cost of a set of rows. */
export type CostTotals = z.infer<typeof costTotalsSchema>;

/** What a cost row is: a bot turn, a voice understanding call, or a call only the gateway saw. */
export const COST_ROW_KINDS = ["turn", "voice_understanding", "gateway_call"] as const;
/** What a cost row is. */
export type CostRowKind = (typeof COST_ROW_KINDS)[number];

/**
 * One row of the cost index with its dimensions. `source` is `session` for a row derived from the session's cost records
 * and `gateway` for a call only the model gateway observed; `estimated` is true for a gateway row whose figures are the
 * gateway's own estimate of an interrupted stream.
 */
export const costRowSchema = z.object({
	id: z.string(),
	row_kind: z.enum(COST_ROW_KINDS),
	turn_id: z.string().nullable(),
	bot_id: z.string().nullable(),
	channel_id: z.string().nullable(),
	member_id: z.string().nullable(),
	prompt_message_seq: z.number().int().nullable(),
	message_seq: z.number().int().nullable(),
	owner_kind: z.string().nullable(),
	status: z.string().nullable(),
	source: z.enum(["session", "gateway"]),
	estimated: z.boolean(),
	recorded_at: z.string(),
	updated_at: z.string().nullable(),
	totals: costTotalsSchema,
});
/** One row of the cost index. */
export type CostRow = z.infer<typeof costRowSchema>;

/** The filters a cost request applied, echoed so the caller sees what the totals cover. */
export const costFiltersSchema = z.object({
	bot_id: z.string().nullable(),
	channel_id: z.string().nullable(),
	member_id: z.string().nullable(),
});
/** The filters a cost request applied. */
export type CostFilters = z.infer<typeof costFiltersSchema>;

/** One group of a rollup: `key` is null for the rows that do not carry the dimension (voice and gateway rows have no bot). */
export const costGroupSchema = z.object({ key: z.string().nullable(), totals: costTotalsSchema });
/** One group of a rollup. */
export type CostGroup = z.infer<typeof costGroupSchema>;

/** GET /orgs/{tenant_id}/costs: the totals of the date range and, with `group_by`, the groups that add up to them. */
export const costSummaryResponseSchema = z.object({
	tenant_id: z.string(),
	from: isoDay,
	to: isoDay,
	group_by: z.enum(COST_GROUP_BY_VALUES).nullable(),
	filters: costFiltersSchema,
	totals: costTotalsSchema,
	groups: z.array(costGroupSchema),
	next_cursor: z.string().nullable(),
});
/** GET /orgs/{tenant_id}/costs. */
export type CostSummaryResponse = z.infer<typeof costSummaryResponseSchema>;

/** GET /orgs/{tenant_id}/costs/turns: the rows of the date range, newest first, one page at a time. */
export const costRowsResponseSchema = z.object({
	tenant_id: z.string(),
	from: isoDay,
	to: isoDay,
	filters: costFiltersSchema,
	totals: costTotalsSchema,
	rows: z.array(costRowSchema),
	next_cursor: z.string().nullable(),
});
/** GET /orgs/{tenant_id}/costs/turns. */
export type CostRowsResponse = z.infer<typeof costRowsResponseSchema>;

/** GET /orgs/{tenant_id}/channels/{channel_id}/cost: the session total, its split by bot (and by model, in `totals`), and its turns. */
export const channelCostResponseSchema = z.object({
	tenant_id: z.string(),
	channel_id: z.string(),
	from: isoDay,
	to: isoDay,
	totals: costTotalsSchema,
	by_bot: z.array(costGroupSchema),
	rows: z.array(costRowSchema),
	next_cursor: z.string().nullable(),
});
/** GET /orgs/{tenant_id}/channels/{channel_id}/cost. */
export type ChannelCostResponse = z.infer<typeof channelCostResponseSchema>;

const messageSide = z.object({ totals: costTotalsSchema, rows: z.array(costRowSchema) });

/**
 * GET /orgs/{tenant_id}/channels/{channel_id}/messages/{seq}/cost. `triggered` is the cost of the turns the message
 * prompted (a member message); `produced` is the cost of the turns that wrote the message (a bot reply). Either side is
 * empty when the message is not that kind.
 */
export const messageCostResponseSchema = z.object({
	tenant_id: z.string(),
	channel_id: z.string(),
	message_seq: z.number().int(),
	triggered: messageSide,
	produced: messageSide,
});
/** GET /orgs/{tenant_id}/channels/{channel_id}/messages/{seq}/cost. */
export type MessageCostResponse = z.infer<typeof messageCostResponseSchema>;

/** One model call of a turn, read from the cost record the session keeps for it. */
export const costCallSchema = z.object({
	conversation_id: z.string(),
	entry_id: z.number().int(),
	kind: z.enum(["turn_round", "compaction", "voice_understanding"]),
	round: z.number().int(),
	provider: z.string(),
	model: z.string(),
	response_id: z.string().nullable(),
	input_tokens: z.number().int(),
	cache_read_tokens: z.number().int(),
	cache_write_tokens: z.number().int(),
	output_tokens: z.number().int(),
	reasoning_tokens: z.number().int(),
	context_tokens: z.number().int(),
	price_book_id: z.string(),
	tier: z.enum(["standard", "long_context"]).nullable(),
	priced_with: z.array(z.string()),
	input_rate_per_million_usd: dollars.nullable(),
	output_rate_per_million_usd: dollars.nullable(),
	cost_usd: dollars.nullable(),
	unpriced: z.boolean(),
	recorded_at: z.string(),
});
/** One model call of a turn. */
export type CostCall = z.infer<typeof costCallSchema>;

/**
 * GET /orgs/{tenant_id}/turns/{turn_id}/cost. `row` is the turn's index row (null while the turn has recorded nothing);
 * `calls` are the session's call records, which sum to the row once the turn has recorded them all.
 * `calls_available` is false when the session could not be read.
 */
export const turnCostResponseSchema = z.object({
	tenant_id: z.string(),
	turn_id: z.string(),
	channel_id: z.string(),
	bot_id: z.string(),
	row: costRowSchema.nullable(),
	totals: costTotalsSchema,
	calls: z.array(costCallSchema),
	calls_available: z.boolean(),
});
/** GET /orgs/{tenant_id}/turns/{turn_id}/cost. */
export type TurnCostResponse = z.infer<typeof turnCostResponseSchema>;

/** The normalized figures of the compare view; a figure is null when its denominator is zero or the total is not known. */
export const costMetricsSchema = z.object({
	turns: z.number().int().nonnegative(),
	cost_per_turn_usd: dollars.nullable(),
	cost_per_call_usd: dollars.nullable(),
	calls_per_turn: z.number().nullable(),
	cached_input_ratio: z.number().nullable(),
});
/** The normalized figures of the compare view. */
export type CostMetrics = z.infer<typeof costMetricsSchema>;

/** One subject of a comparison. */
export const costCompareItemSchema = z.object({ id: z.string(), totals: costTotalsSchema, metrics: costMetricsSchema });
/** One subject of a comparison. */
export type CostCompareItem = z.infer<typeof costCompareItemSchema>;

/** GET /orgs/{tenant_id}/costs/compare: the totals and normalized metrics of two or more channels or turns, in the order asked. */
export const costCompareResponseSchema = z.object({
	tenant_id: z.string(),
	subject: z.enum(["channel", "turn"]),
	items: z.array(costCompareItemSchema),
});
/** GET /orgs/{tenant_id}/costs/compare. */
export type CostCompareResponse = z.infer<typeof costCompareResponseSchema>;

/** The columns of a turn-grain export, in order. */
export const COST_EXPORT_TURN_COLUMNS = [
	"id",
	"row_kind",
	"turn_id",
	"bot_id",
	"channel_id",
	"member_id",
	"prompt_message_seq",
	"message_seq",
	"owner_kind",
	"status",
	"source",
	"estimated",
	"recorded_at",
	"calls",
	"input_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"output_tokens",
	"priced_cost_usd",
	"cost_usd",
	"unpriced_calls",
	"price_book_ids",
] as const;

/** The columns of a call-grain export, in order. */
export const COST_EXPORT_CALL_COLUMNS = [
	"turn_id",
	"bot_id",
	"channel_id",
	"member_id",
	"conversation_id",
	"entry_id",
	"kind",
	"round",
	"provider",
	"model",
	"response_id",
	"input_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"output_tokens",
	"reasoning_tokens",
	"context_tokens",
	"price_book_id",
	"tier",
	"priced_with",
	"input_rate_per_million_usd",
	"output_rate_per_million_usd",
	"cost_usd",
	"unpriced",
	"source",
	"estimated",
	"recorded_at",
] as const;

/** The query of the rollup and list routes, as the Front Door parses it. */
export const costQuerySchema = z.object({
	from: isoDay.optional(),
	to: isoDay.optional(),
	bot_id: z.string().min(1).optional(),
	channel_id: z.string().min(1).optional(),
	member_id: z.string().min(1).optional(),
	group_by: z.enum(COST_GROUP_BY_VALUES).optional(),
	limit: z.coerce.number().int().min(1).optional(),
	cursor: z.string().min(1).optional(),
});
/** The query of the rollup and list routes. */
export type CostQuery = z.infer<typeof costQuerySchema>;
