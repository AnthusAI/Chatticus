# Web

TypeScript Next.js app for chattic.us.

v1 surface:

- bot roster
- chat
- approval cards
- computer preview (watch / takeover later)

Named bots on this surface will use
[Vultus](https://github.com/AnthusAI/Vultus) (`anthus-vultus`) as their
avatar. Drive it from control-plane turn state (waiting, streaming,
idle). Do not give it its own socket. Not Phase 1 or Phase 2.

Talks only to the control plane. Does not reach workers directly.

History and live tokens are decided: server-sent events scoped to one
turn, DynamoDB transcript, reconnect with `after=seq`. See
[Messaging](../docs/MESSAGING.md).
