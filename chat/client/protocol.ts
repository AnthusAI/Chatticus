export type ToolActivityItem = {
  call_id: string;
  /** A last item with tool "more" summarises calls omitted by the server. */
  tool: string;
  summary: string;
  arguments: Record<string, unknown>;
  arguments_truncated: boolean;
  /** Null when no result was recorded for the call. */
  ok: boolean | null;
  result_summary: string | null;
  output: string | null;
  output_truncated: boolean;
  duration_ms: number | null;
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
  /** Tool calls behind a bot reply. Absent when an older server answers. */
  activity?: ToolActivityItem[];
};

export type Turn = {
  turn_id: string;
  tenant_id: string;
  channel_id: string;
  bot_id: string;
  status: "active" | "completed" | "failed" | "reconciling";
  waiting_for: string | null;
  terminal_reason?: string | null;
  prompt_message_seq?: number | null;
};

export type TurnEvent = {
  kind: string;
  seq: number;
  turn_id: string;
  token?: string;
  body?: string;
  /** Reasoning summary on turn.thinking. */
  text?: string;
  /** Tool name on tool.call and tool.result. */
  tool?: string;
  /** Pairs a tool.call with its tool.result. */
  call_id?: string;
  summary?: string;
  arguments?: Record<string, unknown>;
  arguments_truncated?: boolean;
  ok?: boolean;
  output?: string;
  output_truncated?: boolean;
  /** Null when the call began under an earlier attempt. */
  duration_ms?: number | null;
  /** Phase text on computer.starting and computer.ready. */
  detail?: string;
};
