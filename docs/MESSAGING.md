# Messages and the realtime API

Chattic.us is a conversation surface. The control plane is the only
process that writes the transcript and the only process the browser talks
to. Workers never notify the web app. Bots never HTTP-call each other.

## Message store

Postgres is the source of truth for conversations. S3 holds blobs
(screenshots, attachments). The computer snapshot is not the chat log.

A **thread** is one conversation. It belongs to one `tenant_id` and one
user. Participants are that human and one or more of that user's bots.

**Messages** are append-only. Each thread has a monotonically increasing
`seq`. Clients reconnect with `GET /threads/{thread_id}/messages?after=seq`.
Edits and deletes are out of scope for v1.

| Field | Role |
| --- | --- |
| `tenant_id` | Isolation. Required on every row. |
| `seq` | Per-thread order. Replay cursor. |
| `author_kind` | `human` or `bot` |
| `author_id` | `user_id` or `bot_id` |
| `body` | Committed text. Not a token. |
| `addressed_to_bot_id` | If set, the control plane enqueues a turn for that bot |

Files stay on the shared computer. A message may name a path under
`/workspace`. It does not copy the file into Postgres.

## Bot to bot

There is one message table. Bot-to-bot is not a second bus, queue, or
protocol.

1. A bot posts a message in a thread the human can already see.
2. The message is addressed to another bot on that thread.
3. The control plane enqueues a turn for the recipient, same as a human
   message would.
4. The recipient's worker pulls the job. It does not receive an inbound
   HTTP call from the other bot.

The human is not the router. The human still sees the same thread.

## Realtime API

The web app needs tokens as the worker produces them. That is a
**realtime API** on the control plane: an open WebSocket from chattic.us
to a long-lived control-plane process.

```
Worker  --outbound WS-->  Control plane  --realtime API WS-->  chattic.us
                              |
                              v
                           Postgres
                      (committed messages)
```

The worker already streams to the control plane over an outbound
connection. The control plane fans those events out to subscribed
browsers. The browser never reaches a worker.

### Events

| Kind | When | Stored as a message? |
| --- | --- | --- |
| `thread.message.created` | A row is committed | yes, that row |
| `turn.started` | A bot turn begins streaming | no |
| `turn.token` | One token (or a small coalesced chunk) | no |
| `turn.completed` | Tokens are joined into one row | yes, one row |
| `approval.required` | Later, same socket | the proposal, not the action |

Do not insert a message row per token. Coalesce the stream into one
message when the turn completes. If the socket drops mid-turn, the
client replays with `after=seq` and resubscribes. In-flight tokens are
not in the message list until `turn.completed`.

### What the realtime API is not

The socket is held by the **control-plane process** (FastAPI or equivalent
on a small always-on ECS service). That is the same place that commits
messages.

Do not put this on:

- **AppSync.** Managed GraphQL subscriptions over WebSockets. Fine for
  low-volume signals. Too expensive for a token stream.
- **Lambda.** Lambda is for seconds-long HTTP. It is the wrong runtime for
  an open socket that lives as long as a chat tab.
- **API Gateway WebSocket plus Lambda.** Same cost and lifetime problem.
  The gateway is not the fan-out; a process that already has the event is.
- **SNS or SQS per token.** Too chatty. Queue turns. Fan out tokens
  in-process (v1 household) or with Postgres `LISTEN/NOTIFY` when there
  is more than one control-plane task.

SSE is acceptable later as a read-only fallback. The v1 API is a
WebSocket so the same connection can carry approvals the other way.

### HTTP vs the socket

| Path | Use |
| --- | --- |
| `POST /threads` | Open a thread |
| `POST /threads/{id}/messages` | Human (or bot) commits a message |
| `GET /threads/{id}/messages?after=seq` | History and reconnect |
| `GET /ws` (realtime API) | Live events for a subscribed thread |

Lambda may terminate the REST calls. It does not hold `/ws`.

v1 is one household. One control-plane task can fan out from commit
hooks. Several tasks share the same Postgres; they notify each other
with `LISTEN/NOTIFY` so a browser pinned to task A still sees tokens
that arrived on task B. Sticky sessions are optional, not a substitute
for replay.
