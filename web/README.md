# Web

TypeScript Next.js app for chattic.us.

v1 surface:

- bot roster
- chat
- approval cards
- computer preview (watch / takeover later)

Talks only to the control plane. Does not reach workers directly.

History is REST (`GET /threads/{id}/messages?after=seq`). Live tokens,
new messages, and later approvals arrive on the **realtime API**: a
WebSocket to the control-plane process. See
[Messages and the realtime API](../docs/MESSAGING.md).
