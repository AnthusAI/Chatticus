# Approval spec (v1)

This is the recorded decision for epic 76d3e2: how Chatticus reconciles
"work continues when the laptop is closed" with "consequential actions
are gated" while v1 is a web tab. Device push is "come back, something
finished," not "approve this now" ([Messaging](MESSAGING.md)). iOS is v3.

The live thin-turn slice does not run approvals yet. The kernel and
Gherkin below are the contract the worker HTTP loop must honor before
overnight work or a browser can reach a consequential sink.

## Consequential classes

These action types always gate unless a control below allows them:

| Class | Meaning |
| --- | --- |
| `send` | Message, email, or other outbound communication |
| `publish` | Make content public or share it beyond the household |
| `purchase` | Spend money |
| `delete` | Destroy data the household cannot trivially restore |
| `production_change` | Change a live production system |

Reading workspace files and other non-consequential work may run
unattended. Egress that sends household data anywhere is approval-class
whether it looks like a message, a form post, a file upload, or a URL
the agent navigates to ([Threat model](THREAT_MODEL.md)).

## Unattended (laptop closed)

v1 has no completable approval path while nobody is at a screen. A
routine or overnight turn that reaches a consequential class must
either **stop visibly** or **run against a control that already binds
the exact operation**. Silent failure and indefinite blocking without a
visible waiting state are both out of scope.

| Channel | May run unattended? | Control |
| --- | --- | --- |
| Structured connector (API, MCP, named tool) | Only if a **human** created an always-allow rule that matches **this action type and these exact arguments** | `features/overnight_gated_action.feature` |
| Generic authenticated browser | Never | Unbound send / publish / purchase / delete / production change stop with `user_controlled_completion_required`. A screenshot or click coordinate is not approval. |

Type-only always-allow (action type without argument bindings) does
**not** authorize overnight execution. A bot cannot add or loosen an
always-allow rule. Retrying the same unbound or unmatched action while
still unattended is forbidden.

When the human is back at the tab, they approve a **concrete
operation** (destination and payload as the target system will receive
them), not a model-authored summary. That approval authorizes only that
immutable operation (`features/exact_consequential_approval.feature`).
Changing destination or payload requires a new approval. Completion
evidence is the target system's result, not the agent's report.

## Presence

No v1 approval design depends on a human being present at a screen
unless that presence is guaranteed. Presence is guaranteed only for
interactive review in the web tab. Overnight work must not assume it.
Push notification is not presence.

Human takeover of a browser session is a binding control for
authenticated browser actions; it is interactive and therefore not an
overnight path.

## Kernel vs live

| Piece | Where it lives | Live on ChatticusThinTurn? |
| --- | --- | --- |
| Default require-approval / never-allow | `features/approvals.feature` | No |
| Overnight stop or exact human rule | `features/overnight_gated_action.feature` | In-process kernel |
| Immutable structured approval | `features/exact_consequential_approval.feature` | In-process kernel |
| Unbound browser stop | `features/unsupported_browser_action.feature` | In-process kernel |
| Page-content cannot expand authority | `features/page_content_authority.feature` | In-process kernel |
| Task grant, contexts, injection, exclusions | [Browser authority](BROWSER_AUTHORITY.md) | In-process kernel |

The control-plane sink adapters in ``capability_sinks`` enforce these
kernels before file, credential, egress, connector, and consequential
operations run. Full Lambda and HTTP worker wiring remains incremental.

## Exclusions (v1)

- iOS or push as an approval client (v3)
- Routine scheduling mechanics (v2)
- Loosening auto-review so unattended work finishes by default
- Pre-authorizing generic browser clicks overnight
- Bot-created always-allow rules
- Binding a generic browser click to an immutable operation (see
  [Browser authority](BROWSER_AUTHORITY.md))
