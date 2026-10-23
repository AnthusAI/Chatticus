# Shared Chatticus chat: Papyrus implementation handoff

Planning handoff only. No production implementation, release, merge or deployment is included.

The complete reviewed plan and five actual Archify illustrations are filed in Papyrus on branch `docs/PPY-eeb023-chatticus-chat-plan`:

- `docs/chatticus-chat-integration-plan.md`
- `docs/architecture/chatticus-chat/`

Repository: <https://github.com/AnthusAI/Papyrus/tree/docs/PPY-eeb023-chatticus-chat-plan/docs>

## Resume on the Mac

Read both repositories' current AGENTS.md and Kanbus records. Work from fresh `origin/develop` in isolated worktrees; do not overwrite existing workers' changes. Papyrus's loading UX task owns newsroom loading states, Notification Center focus/removal of Go to, and mobile navigation alignment. The chat slice owns the new shared packages and the `papyrus-console-shell` chat adapter only; coordinate before touching shared shell files.

Start with the client/React extraction. The existing `web/components/assistant-ui/ChatticusAssistantRuntime.tsx` already takes externally supplied messages, turn state and send callbacks. `web/lib/sse.ts`, `sse-parse.ts` and `resumable-turn-stream.ts` supply the HTTP/SSE seam. Remove product login, roster, cost-panel and computer dependencies from the shared package boundary; retain product adapters/slots. Make Chatticus consume its extracted code before adding the Papyrus consumer. Package and test locally; do not publish to a registry without authorization.

The code uses TypeScript `@earendil-works/pi-durable` 1.0.2. The user clarified that the earlier PyAgents/PyDurable issue wording likely meant this runtime. No Python package identity was verified. Do not make a Python migration a prerequisite for UI reuse or create another Python model loop in Papyrus. Later server extraction should reuse the existing TypeScript Pi Durable implementation and explicitly resolve the Papyrus Python-first backend/hosting boundary.

Kanbus: `chatticus-abde29` (epic), `chatticus-080b0e` (story), Papyrus `PPY-de11ec`, `PPY-eeb023`, `PPY-a438d0`, `PPY-7962e3`, `PPY-61ee23`. These records remain open. The Chatticus planning records are staged on this handoff branch rather than pushed to `develop`: that push would start deployment workflows, which are not authorized by this handoff. Land board records through the normal workflow when that side effect is authorized; do not open a product PR mixing them with implementation.

Before coding, write executable Gherkin and observe the expected failure. Verify a standalone consumer can send once and render host messages without Chatticus membership or computer state; reconnect resumes after the last event and deduplicates replay. Check packaged exports/CSS/types and the actual consumer. Later acceptance additionally needs per-editor/site privacy, current editor permissions, exact-action approvals, durable jobs/continuations, transcript migration and Slack cutover.

No server, account, credential, security access or cloud changes were performed. The requesting user paused implementation and asked for planning to be pushed so a Mac agent can continue. Local-only test scaffolding is not part of the handoff branch and is not a completed implementation.
