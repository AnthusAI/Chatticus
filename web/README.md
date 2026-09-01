# Web

TypeScript Next.js product workspace. Production hostname: `hey.chattic.us`.

v1 surface:

- bot roster
- chat
- approval cards
- computer preview (watch / takeover later)

Named bots on this surface use the
[Vultus](https://github.com/AnthusAI/Vultus) (`anthus-vultus`) avatar model
zoo. Explicit Editor, Reporter, Copy Writer, and Illustrator roles select
distinct, original Lottie models; bots without an assigned role use the
procedural compatibility model. The roster and chat header render `BotAvatar`,
driven from the existing turn SSE stream (`turn.started`, `turn.waiting`, coalesced
`turn.token`, completion) with no separate avatar socket.

Talks only to the control plane. Does not reach workers directly.

History and live tokens are decided: server-sent events scoped to one
turn, DynamoDB transcript, reconnect with `after=seq`. See
[Messaging](../docs/MESSAGING.md).
