# Organizations (v1)

This is the recorded decision for initiative 86aec8: who may use Chatticus,
what they share, and what they are allowed to approve or see.

An **organization** is an organizational unit in the multi-tenant system:
the isolation boundary that owns a computer, and the thing that has many
users. `tenant_id` is its identifier in code, keys, and the worker
protocol. "Organization" is the product name for the same object. One
identifier, two audiences. Renaming `tenant_id` was considered and
rejected: it is a partition key prefix on every item, a field on eleven
dataclasses, a column in most feature files, and part of a worker
protocol that does not redeploy in lockstep with the control plane.

A **deployment** is one AWS account running one set of stacks, and it
holds many organizations. AWS spend and the vendor project are metered
per deployment, so per-organization cost is internal chargeback rather
than an invoice. See [Budgets](BUDGETS.md). Business organizations and
AWS Organizations are separate things that may map onto Chatticus
organizations in whatever way a deployment calls for; nothing in this
design depends on that mapping.

The household case is not special. A household is an organization with
one member.

## The office model

Chatticus organizations work the way an office works. This is the
governing metaphor, and it decides the arguments below.

An office does not protect the company by keeping employees out of the
filing room. The room is shared on purpose. What differs between people
is what they may **commit the company to**, what they may **see**, and
who may **delegate** either. The compensating control for a shared room
is the audit trail, not a lock on every drawer.

| Office | Chatticus |
| --- | --- |
| The office | Organization (`tenant_id`) |
| Shared filing room, shared logins, the company card | The organization computer: `/workspace`, browser profile, credentials |
| A locked drawer | A named browser session or scoped resource whose use is itself an authority |
| Your signing authority | An authority ceiling over the consequential classes and their arguments |
| A standing instruction to the mailroom | `AutoReviewRule` always-allow with argument bindings |
| "Sam approves while I am out" | Delegation, clipped and expiring |
| Escalating to your director | Approval routing to the nearest sufficient ceiling |
| A meeting you were not in | A channel you are not a participant of |

## Identity

Authentication is outsourced. A Cognito user pool per environment
federates **Google** and nothing else. Google and Apple are native social
providers and bill against the 10,000 MAU free tier; generic OIDC
federation bills against a 50 MAU tier, which is what a GitHub shim would
have cost on top of writing the shim. Apple is deferred until an iOS
client justifies the Developer Program.

Cognito authenticates. It does **not** model organizations. Cognito
groups are the wrong home for membership: they are global to the pool,
they land in the token, and token claims go stale against the records
that govern spending. The token says who you are. Membership, role, and
ceiling are resolved server side, per request, from DynamoDB.

`user_id` is global and minted at first sign-in, keyed by verified email.
One human is one account. Their data is organization-partitioned, which
the existing keys already express.

## Enablement and the waitlist

Whether a signed-in person may **create** an organization is a **deployment
switch**, not a global product law. Each deployment sets
`CHATTICUS_SIGNUP_MODE`:

| Deployment | Signup mode | Product behavior |
| --- | --- | --- |
| Anthus (`development`, `staging`, `production`) | `open` | Google sign-in is the waitlist form; `POST /organizations` creates a pending org |
| Customer deployment | `invitation_only` | Sign-in only; creation is refused until an invitation exists |

The web SPA reads the matching build-time flag
`NEXT_PUBLIC_CHATTICUS_SIGNUP_MODE`. The HTTP front door enforces the server
value even when the web flag is wrong.

On an open-signup deployment, anyone may sign in and create an organization.
Creating one lands it `pending`. Enabling is a deliberate act, and it is per
**organization**, not per person: the owner then invites their own people, and
invited members of an enabled organization never see the pending welcome
screen.

The alternative was enabling individuals, which makes Chatticus the
gatekeeper for every employee of every customer forever, and builds the
organization boundary twice because billing needs it anyway.

Enabling an organization approves one organization computer's worth of
recurring spend. That is the cost gate, and it is why the waitlist exists.

A waitlisted principal costs one DynamoDB read per request. Routing is
**default deny**: a route serves an enabled member unless it is
explicitly marked reachable by a waitlisted one. A denylist of expensive
routes was rejected, because the next route someone adds is open by
default, and one day that route is the one that calls the model.

Domain-based auto-join is excluded from v1. Joining an organization
because an email domain matches requires proving the organization owns
that domain, or someone claims a public mail domain and harvests every
signup. Invitations only.

## The shared workplace

**Decided: the computer is organization-wide.** One workplace per
organization, shared by every member and every bot.

The reason is collaboration. A shared file system is what lets a bot
continue from files another bot saved, lets a person pick up what a bot
left, and lets a bot finish what a person started. Handoff between
teammates is the product. A workplace partitioned per person or per bot
would have to reinvent handoff as a transfer.

This widens the scope in [Product](PRODUCT.md); it does not reverse its
principle. That document already says files under `/workspace` are
visible to every bot and that one bot continues from files another bot
saved. A per-bot workplace would have broken that. An organization-wide
one keeps it and moves the boundary from the user to the organization.

[Threat model](THREAT_MODEL.md) said the user is the security boundary.
For a household those were the same sentence. Now that they differ, the
**organization** is the boundary: it holds the credentials, pays the
bills, and signs the contracts.

State the consequence rather than the rule. A shared workplace means
isolation is no longer doing any of the work between members. The
authority ceiling is therefore not a later refinement; it is the only
control standing between a member and the company card, and it is
required in v1.

## Authority

Every member holds a ceiling over the consequential classes in
[Approval](APPROVAL.md) and over their arguments.

> No one can grant, approve, or always-allow beyond their own ceiling.

Every task grant, approval, and always-allow rule is clipped to the
ceiling of the human who created it. A bot's effective authority for a
turn is the intersection of what the bot was granted and the ceiling of
the member who asked. Delegation is the same clip applied downward, with
an expiry; the table's TTL attribute already expires items, so a
covering-while-I-am-out delegation needs no new machinery.

A ceiling is not a subset of the five consequential classes. Real standing
is narrower and domain-shaped: one member may approve a publication to
production, another only a copy edit, another only the ingestion of a
reference. Those differ by **argument**, not by action type. Approving a
copy edit and approving a production publication are both `publish`; what
separates them is the target.

So a ceiling has the shape the kernel already uses.

| Field | Bounds |
| --- | --- |
| `action_types` | Consequential classes, each with argument constraints |
| `origins` | What may be ingested, and from where |
| `recipients` | Who may be sent to |
| `file_scopes` | What may be read or written |
| `egress_classes` | Which kinds of outbound data |
| `spend_limit` | The ceiling on `purchase` |

That is `TaskCapabilityGrant` with argument-bound action types and a spend
limit. The unification is the point: **a ceiling is a grant a person holds
standing, rather than one a task receives.** One matcher, four lifetimes.

| Object | Lifetime | Held by |
| --- | --- | --- |
| Ceiling | Standing, revocable | A member |
| Delegation | Bounded, expiring | A member, clipped from another's ceiling |
| Always-allow rule | Standing, argument-bound | The organization, authored within a ceiling |
| Task grant | One turn | A task, clipped by the granting member |
| Approval | One immutable operation | One action, bound by the approver |

Clipping is then set intersection on the same fields, everywhere.

**Roles are named ceilings, not a permission matrix.** `owner` is the
full ceiling. `member` is one that excludes `purchase` and
`production_change`. Later granularity is a change to ceiling data, not a
redesign, which defers a decision that cannot be made well yet.

Three gaps in the current kernel. The five consequential classes are an
**egress** taxonomy, inherited from a household where the only question
was what leaves. Ingesting a reference is an approval-worthy act in an
organization, and it is also the primary attack in
[Threat model](THREAT_MODEL.md). `TaskCapabilityGrant.origins` and
`EgressClass.APPROVED_ORIGIN_FETCH` already carry half of it; ingest needs
to become a class a ceiling can bound, not only a grant field.

The other two gaps are narrower. `AutoReviewRule.created_by` records a
**kind** (`human` or `bot`), and `rule.user_id` is a scope match, not the
author. So "a bot cannot write a rule" is enforceable today and "this
member cannot write a rule broader than their own standing" is not. The
rule needs a creator identity distinct from its scope, and approvals need
an approver identity.

Approval routing improves on the hardest problem in
[Approval](APPROVAL.md), which records that v1 has no completable path
while nobody is at a screen. Presence in an organization is a team
property. An action that exceeds the requester's ceiling escalates to the
nearest member whose ceiling covers it, and `human_takeover` and
`immutable_approval` can be satisfied by any of them.

## Views

The organization has one computer and many **views** of it. A view is the
projection of the shared workplace for one member and one turn: which file
scopes, which named browser sessions, which channels.

A view is enforced where authority is enforced, at the capability sink,
not on the disk. `TaskCapabilityGrant` already carries `file_scopes`,
`origins`, and `recipients`, and a grant is clipped by the ceiling of the
member who made it. So the same mechanism that decides whether a bot may
spend money decides what it may read. The web app renders the same
projection the sink enforces; the view a person sees and the view their
bot gets are one object, not two.

`PolicyBrowserContext.storage_partition` and `Computer.browser_sessions`
already name isolated contexts that never share cookies or storage. Access
to a named session is an authority held under the same ceiling rule. That
is where per-purpose credential separation lives, and it is why an
organization-wide computer does not corner us.

Channel participation is the other half of a view, and
`ChannelParticipant{kind, actor_id}` already models it.

Say plainly what this is. A view is a professional boundary, not a vault.
It is enforced by Chatticus at the sink layer, on the operations a model
asks for. It is not an operating system permission, and a turn that
reaches a general shell on the computer is outside it. That is the same
posture as an office, where the filing room is governed by what people are
supposed to do rather than by a lock on every drawer, and it is only
defensible because the organization, not the member, is the boundary.

## Connections between organizations

Organizations inside one deployment will need to work together, so they
need a way to reach each other. This is the feature that punches a hole
in the only hard boundary the design has, so the rules matter more than
the mechanism.

`{tenant_id}#channel#{id}` is a physical partition today. A connection is
a deliberate, narrow exception to it, and it is built from the primitive
that already exists: a **clip**.

Four rules.

- **Grants name a resource, never an organization.** "Support may read this
  channel" is a connection. "Support may reach Legal" is not a
  connection, it is a merge.
- **A connection is clipped twice.** By the ceiling of the member who
  grants it, and again by what the granting tenant's owner permits to
  leave the tenant at all. Neither alone is sufficient: an individual
  should not be able to export the department, and a department policy
  should not grant what the individual granting it does not hold.
- **Received authority is borrowed, not owned.** A grant received from
  another organization is never part of the receiver's ceiling, which is what
  makes connections **non-transitive**: B cannot re-share A's grant with
  C, because B never held it. Without this distinction, re-sharing
  happens by accident and the boundary leaks one hop at a time.
- **Never at the workplace level.** A connection may reach a channel or a
  named resource. It never reaches the computer. The tenant's workplace,
  its files, and its browser sessions are the thing the boundary exists
  to protect, and a shared workplace across tenants would collapse the
  boundary entirely rather than open a door in it.

Revocable and audited follow from the above: a connection is a record
like any grant, it expires like any delegation, and every use of it is
attributable to the member who acted.

**Cost note.** One computer per organization means a deployment's Fargate
spend scales with the organizations inside it. That is the right shape,
since an organization that does no work costs nothing, but it belongs in
the deployment's budget expectations.

## Non-requirements (v1)

State these so a customer knows what they are buying.

- Chatticus does not isolate members of one organization from each
  other's credentials on the shared computer. The organization is the
  boundary.
- Bots are not a security boundary. That was already true and remains so.
- No per-member `/workspace` partition and no operating system
  permissions. Views are enforced at the capability sink, not the disk.
- No domain-verified auto-join.
- No Apple sign-in.
- No billing mechanics. The boundary billing needs is built here; the
  charging is not.

## Still open

- **Bot memory carries across channels.** `Bot.memory` is per bot, not
  per channel, and a bot reads the compacted view of every channel it
  joins. A bot in a restricted channel and an open one is a path between
  them. An office handles this with discretion; a bot has no discretion.
  Either bot memory becomes channel-scoped, or a bot's channel membership
  is itself bounded by a ceiling.
- Whether `approval_fatigue`, currently in `V1_POLICY_EXCLUSIONS`, can
  stay excluded once five people share one bot.
- Whether an organization may hold more than one computer, and if so
  whether the second one is a named resource rather than a second
  workplace.
- How audit is surfaced. The turn record already attributes every action
  to a requesting actor; nothing presents it to an owner yet.

## Documents this supersedes

These say "user" where they will say "organization" once the work lands.
They are accurate for the household today and should change with the
epic that changes the behavior, not before.

- `docs/PRODUCT.md`: the computer is isolated to the user.
- `docs/THREAT_MODEL.md`: bots are not a security boundary, the user is.
- `AGENTS.md`: the computer is shared by all of a user's bots.
