# Web

TypeScript Next.js app for chattic.us.

v1 surface:

- bot roster
- chat
- approval cards
- computer preview (watch / takeover later)

Named bots on this surface use
[Vultus](https://github.com/AnthusAI/Vultus) (`anthus-vultus`) as their
avatar. The roster and chat header render `BotAvatar`, driven from the
existing turn SSE stream (`turn.started`, `turn.waiting`, coalesced
`turn.token`, completion) with no separate avatar socket.

Talks only to the control plane. Does not reach workers directly.

History and live tokens are decided: server-sent events scoped to one
turn, DynamoDB transcript, reconnect with `after=seq`. See
[Messaging](../docs/MESSAGING.md).
