/** Names of the counters the channel features keep; they carry no message text and no address. */
export type ChannelMetricName =
	| "inbound_received"
	| "inbound_refused"
	| "inbound_charset_fallback"
	| "inbound_admitted"
	| "inbound_unknown_route"
	| "inbound_duplicate"
	| "inbound_gate_closed"
	| "inbound_unlinked_sender"
	| "inbound_automated_dropped"
	| "inbound_bot_not_in_conversation"
	| "inbound_sender_not_in_conversation"
	| "outbound_sent"
	| "outbound_failed"
	| "outbound_gave_up"
	| "status_event_rejected"
	| "status_event_applied";

/** Counts channel events. Unknown routes are counted, never stored. */
export interface ChannelMetrics {
	count(name: ChannelMetricName, dimensions?: Readonly<Record<string, string>>): void;
}

/** Metrics that count nothing, for a deployment that has no metrics sink yet. */
export const NO_CHANNEL_METRICS: ChannelMetrics = { count: () => undefined };
