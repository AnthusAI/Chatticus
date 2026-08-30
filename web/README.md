# Web

TypeScript Next.js app for chattic.us.

v1 surface:

- bot roster
- chat
- approval cards
- computer preview (watch / takeover later)

Talks only to the control plane. Does not reach workers directly.

History and live tokens are decided: server-sent events scoped to one
turn, DynamoDB transcript, reconnect with `after=seq`. See
[Messaging](../docs/MESSAGING.md).
