# External channels

> Addresses are written with AT in place of the at sign so repository scanners do not flag them.
>
> **Status:** the contract for the initiative "External channels: bots reachable by email, SMS, Slack, Teams and
> Discord". Milestone 1 is built in part (section 17 says exactly what). Facts about the deployed AWS account were read
> on 2026-10-21 with read-only calls (section 11). Facts about third-party services are from the planner's knowledge and
> every one that carries a number or a deadline is marked **verify** and has a task that checks it before code depends
> on it. The behavior is specified in `features/external_channel_binding.feature`,
> `features/external_conversation_mapping.feature`, `features/external_inbound_admission.feature` and
> `features/external_outbound_delivery.feature`; read `features/external_channels_narrative.md` for the order.

Related: [Messaging](MESSAGING.md), [Organizations](ORGANIZATIONS.md), [Approval](APPROVAL.md),
[Design challenges](DESIGN_CHALLENGES.md), [Threat model](THREAT_MODEL.md).

## 0. The recommendation in brief

1. One provider-neutral port, the **channel transport**, and one provider-neutral core, the **channel binding service**.
   Every provider is an adapter behind the port. The core owns identity, authorization, deduplication, abuse limits,
   conversation mapping, delivery state and cost gates exactly once. Adapters own bytes: verify, parse, render, send.
2. An external conversation maps onto **exactly one existing Chatticus channel**. No thread object is added. An email
   thread, a Slack thread and a guest's SMS exchange each become one channel; a member's SMS or direct message to a bot
   lands in that member's existing direct channel with the bot.
3. **Replies follow the prompt's origin.** A bot's answer is delivered to an external transport only when the message
   that started the turn arrived over that transport. A turn started in the web app never leaks to email or SMS.
   Anything else (a new recipient, a new thread, an attachment from the workspace) is a `send` and is approval-gated.
4. **Strangers cost nothing.** Unknown senders are quarantined by deterministic code. No model call, no turn, no spend,
   until an owner admits the sender.
5. **Approvals never travel over an external channel in v1 of this design.** An email or SMS can notify "approval
   needed, open the app". The decision is a POST from the signed-in web app.
6. **Email first, through SES, in the SES sandbox.** Inbound (receipt rule to S3 and Lambda) is not restricted by the
   sandbox; outbound works to verified addresses and to the SES mailbox simulator. Milestone 1 is fully Gherkin-tested
   against an in-memory fake transport and proven live with one owner-verified address.
7. **Slack second** (Events API, HTTPS only), then **Teams**. **Discord is deferred**: without the Gateway websocket it
   cannot receive ordinary messages, only slash commands.
8. **SMS last, through AWS End User Messaging SMS with a toll-free number.** Amazon Connect is a contact-center product
   and is overkill. Carrier registration has a multi-week lead time, so the registration is started early by the owner
   even though the code ships last.
9. Everything is Lambda for HTTP and event handling, DynamoDB for state, S3 for blobs, EventBridge for the
   outbound-delivery wake-up, SQS only for turn jobs (unchanged). No socket, no load balancer, no relational database,
   no IAM user, no long-lived key.
10. Asking Amazon for SES production access is **not** part of milestone 1. It is a gate at the end of milestone 2 and
    the owner decides when (section 11).

## 1. Fit with the existing design

| Existing rule | How this design satisfies it |
| --- | --- |
| A channel is the conversation; no thread | External conversation key -> `channel_id` index; the channel is the thread |
| Every bot reads the channel; only the addressed bot acts | Email `To` picks the addressed bot; `Cc` bot addresses are readers; Slack and others use a binding default bot or an explicit name |
| `tenant_id` on every item; uniform not-found for strangers | Every new item carries `tenant_id`; owner routes answer 404 to non-members; public ingress answers a flat 2xx or generic 4xx that never reveals whether a binding exists |
| Approvals bind the exact operation; unattended runs need a human-created exact rule | Section 6 |
| Per-organization spend ceilings | External turns pass through the same admission and ceiling checks, plus a smaller per-binding daily budget (section 5) |
| No persistent sockets | Slack Events API, Teams Bot Framework HTTPS, Discord Interactions HTTPS, SES inbound, SMS webhooks or SNS. Slack Socket Mode and the Discord Gateway are excluded |
| Nothing bills when nobody works | SES, Lambda, DynamoDB, S3 and EventBridge bill per use. The one exception is a rented SMS number (about 1 to 2 USD per month); it is created only when an organization enables SMS (section 10.2) |
| DynamoDB only | New item types in the existing messaging table; no schema migration |
| AWS only via CDK; no IAM users or long-lived keys | New stacks in `infra/`; provider credentials in SSM SecureString (section 9) |
| Marketing and billing are in a private repo | Nothing here adds billing or marketing |
| Hard cutover, no compatibility forks | Adding `external` as a channel kind and author kind is a plain enum addition in one change; there is one inbound path and one outbound path |

## 2. The core abstraction

### 2.1 Terms

- **Channel binding**: an owner-managed record that says "this external endpoint is attached to this organization".
  Examples: the email address `researcher AT acme.mail.chattic.us` bound to the bot Researcher; a Slack workspace
  installation with a default bot per Slack channel; an SMS number. A binding belongs to one `tenant_id`.
- **Channel transport**: the provider adapter implementing the port below.
- **External identity**: a sender on a provider, for example `email:alice@example.com`, `slack:T123:U456`,
  `sms:+15555550100`. It maps to a member, a guest, a blocked party, or nothing.
- **Conversation key**: the provider's own unit of conversation, the string the index maps to a `channel_id`.

### 2.2 The port

```ts
export type TransportProvider = "email" | "sms" | "slack" | "teams" | "discord" | "fake";

export interface TransportCapabilities {
	readonly maxBodyCharacters: number;
	readonly conversationGranularity: "thread" | "pair";
	readonly supportsAttachments: boolean;
	readonly supportsRichText: "none" | "basic_html" | "provider_blocks";
	readonly reportsDelivery: boolean;
	readonly requiresRecipientOptIn: boolean;
	readonly authenticatesSender: "per_message" | "per_request_signature" | "none";
}

export interface ChannelTransport {
	readonly provider: TransportProvider;
	readonly capabilities: TransportCapabilities;

	/** Pure of side effects. Checks signatures and authentication verdicts; returns a refusal reason or a verified envelope. */
	verifyInbound(raw: RawInbound): Promise<VerifiedInbound | InboundRefusal>;

	/** Pure. One verified envelope may carry several messages (a Slack batch, an email with a bounce report). */
	normalize(verified: VerifiedInbound): InboundEvent[];

	/** Pure. Turns a committed message into the provider payload, applying the provider's length, formatting and threading rules. */
	render(message: CommittedMessage, binding: ChannelBinding, thread: ThreadContext): OutboundPayload;

	/** The only outbound side effect. Idempotent by `idempotencyKey`. */
	deliver(payload: OutboundPayload, binding: ChannelBinding, idempotencyKey: string): Promise<DeliveryReceipt>;

	/** Pure. Turns provider callbacks (bounce, complaint, delivered, opt-out, read) into status events. */
	parseStatus(raw: RawInbound): DeliveryStatusEvent[];
}
```

`InboundEvent` is provider neutral:

| Field | Meaning |
| --- | --- |
| `provider`, `bindingRouteKey` | Where it arrived: the recipient address, the Slack team and channel, the SMS destination number |
| `externalMessageId` | The provider's id: email Message-ID, Slack `ts` with channel, Teams activity id, SMS provider message id. The deduplication key |
| `conversationKey` | The provider's unit: email thread root, Slack `channel:thread_ts` (or `channel:ts` for a new top-level message), a DM or SMS pair |
| `sender` | `{ externalId, displayName, assertion }`. `assertion` records how the provider proved the sender: `dmarc_aligned`, `dkim_aligned`, `request_signature_user_claim`, `carrier_number_unverified` |
| `text`, `attachments[]` | Plain text body (HTML converted, quoted replies stripped, original kept in S3); attachment references already stored in S3 |
| `addressing` | `to` and `cc` bot handles, or the provider's mention or command target |
| `automationHints` | Booleans derived from provider headers: auto-submitted, bulk precedence, bounce report, list mail, our own origin header |
| `receivedAt`, `rawReference` | Time and the S3 key or provider reference of the unmodified original |

### 2.3 The one inbound path

Every transport feeds `admitInbound(event)` in the core. It is the only code that turns external input into a message.

1. **Route.** Look up `route#<provider>#<routeKey>` to get `(tenant_id, binding_id)`. Unknown: drop, count, return the
   provider's normal success so the endpoint is not an oracle.
2. **Deduplicate.** Conditional put of `(binding_id, externalMessageId)`. A repeat returns the first result. Webhook
   retries and SES retries are therefore harmless.
3. **Automation filter.** Auto-replies, bounces, list mail and our own origin header never start a turn (section 5).
   Bounces are routed to the delivery-status path instead.
4. **Sender resolution.** `external identity -> trust class` (section 4): `member`, `guest`, `unknown`, `blocked`.
   `unknown` goes to quarantine and the path ends. `blocked` is dropped and counted.
5. **Gates.** Organization status enabled, binding enabled, rate limits, spend ceiling and the binding's daily external
   budget. A refusal here produces a stored, owner-visible record, never a model call.
6. **Conversation mapping.** Find or create the channel (section 3).
7. **Admit.** Call the existing `postMessage` with `authorKind` `human` for a member and `external` for a guest, with
   the `origin` block, and the addressed bot. The existing message admission, steering and turn start run unchanged. The
   turn grant is chosen by trust class (section 4).

Steps 1 to 5 are deterministic code. The model is first reached in step 7, and only for senders the organization has
admitted.

### 2.4 The one outbound path

1. A turn completes and the control plane commits the answer message (existing behavior).
2. If the turn's prompt message has an `origin`, the commit also writes a `delivery` item `(tenant_id, message_id,
   binding_id)` with status `pending` and emits an EventBridge event `channel.message.created` carrying only ids.
3. An EventBridge rule invokes the delivery Lambda. It loads the message and binding, calls `render`, then `deliver`
   with `idempotencyKey = message_id + binding_id`, and records `sent` with the provider message id, or `failed` with a
   classified reason (`retryable`, `permanent`, `suppressed`, `opted_out`).
4. Provider callbacks (SES events through SNS to Lambda, Slack error responses, SMS delivery receipts) call
   `parseStatus` and update the same `delivery` item: `delivered`, `bounced`, `complained`, `opted_out`.
5. A scheduled sweeper (EventBridge Scheduler, one rule per environment) retries `pending` and `retryable` items older
   than a few minutes up to a bounded count and then marks them `failed`. This is a per-use reaper in the same sense as
   the one described in [Design challenges](DESIGN_CHALLENGES.md); it has no idle floor.

EventBridge here is the per-turn signal "a message finished, deliver it", a second of latency is invisible. It is not
in the token path and no SQS queue is added: SQS stays for turn jobs.

A message the bot sends that is **not** a reply to the prompt origin (a new recipient, a new email thread, a first
message to an SMS number) is not produced by this path. It is produced by an explicit `send_external_message` tool whose
call is a `send` consequential action bound to the exact destination and payload (section 6).

## 3. Mapping onto the single-channel model

Rule: **an external conversation is exactly one channel**, found through an index, never a new object.

`ChannelKind` gains `external`. `ActorKind` gains `external` (a guest author). Members who write from outside still
author as `human` with their `user_id`; the `origin` block records that the message arrived by email.

| Transport | Granularity | Conversation key | Channel |
| --- | --- | --- | --- |
| Email | thread | Root of the thread: the first Message-ID in `References`, else `In-Reply-To`, else the message's own Message-ID | A new `external` channel per thread, named from the subject, with the addressed bots as participants and the member (if the sender is a member) as the human participant, so the thread appears in that member's web sidebar |
| Slack channel or group | thread | `team:channel:thread_ts`, or `team:channel:ts` for a top-level message that starts a new thread | One `external` channel per Slack thread |
| Slack, Teams or Discord direct message | pair | `team:dm_channel` | The member's existing direct channel with that bot (`directChannelId`), so the web conversation and the direct message are one persistent conversation. For a guest, an `external` channel keyed by the pair |
| SMS | pair | `sender_number:destination_number` | Same as direct message |

The index is three kinds of item, all `tenant_id`-scoped:

- `conv#<binding_id>#<conversation_key> -> channel_id`
- `emsg#<binding_id>#<normalized Message-ID> -> channel_id` for every Message-ID we have received or sent, so a reply
  that quotes any earlier message finds its channel even when the client drops `References`
- `route#<provider>#<routeKey> -> (tenant_id, binding_id)` (the one global lookup; it holds no content)

**Email threading detail.** Outbound mail always sets `Message-ID` (our domain), `In-Reply-To` (the inbound message
being answered) and `References` (the accumulated chain, capped). A plus tag in the sender address (`researcher+t7k2 AT ...`)
carries a short HMAC of the `channel_id` as a fallback correlator when a client strips headers. The tag is a hint for
lookup only; it never authorizes anything. A subject change does not split a thread; a missing or unknown reference
starts a new channel.

**Slack thread detail.** `thread_ts` is the key, not a field on messages. A Slack thread reply is a message in the
thread's channel; a top-level Slack message that the bot is addressed in opens a new channel and the bot's reply is
posted with `thread_ts` of that message, so the Slack thread and the Chatticus channel stay one-to-one.

**Which bot answers.** Email: the `To` bot address. Cc'd bot addresses read but are not addressed. Slack: a binding
holds a default bot per Slack channel; `@mention` or the first word of the text selects another bot of the same
organization. Replies carry the bot's name through Slack's per-message username and icon override, so one installed app
presents as several named teammates.

**Steering.** If an addressed bot already has an open turn on the channel, the existing steering rule applies unchanged.
A web message that steers a turn an external message started carries no origin and is never delivered outside; the
turn's reply is still owed to the external sender who started it, or to the most recent external message the turn took
in, because that person is the one waiting for the answer. A web message alone never creates, changes or removes the
place a reply is owed.

## 4. Identity and authorization

### 4.1 Trust classes

| Class | Who | What an inbound message may do |
| --- | --- | --- |
| `member` | An external identity linked to an enabled member of this organization | Starts a turn as that member with the conversational grant only (section 6). Role is read at every request, so removal takes effect at the next message |
| `guest` | An external identity an owner explicitly admitted for this binding | Starts a turn with the **guest grant**: no computer, no workspace, no consequential action, replies only on the same thread, smaller spend budget |
| `unknown` | Anyone else | Stored in quarantine with a bounded retention; no turn, no model call. Owners see a count and may admit, reject or block |
| `blocked` | Explicitly blocked or auto-blocked for abuse | Dropped and counted |

Admitting an unknown sender is a human decision in the web app by an owner. It is recorded with who, when and what the
sender first wrote. Admission applies to a sender on a binding; it is not organization-wide trust.

### 4.2 How an external identity becomes a member

An external identity is linked to a member only after proving control of it:

- **Email.** A member's verified sign-in email is a candidate. The link exists when an inbound message from that address
  passes the authentication policy below. No separate ceremony is needed because address ownership is proven both ways:
  the member signed in with Google using that address, and the message authenticates as that domain.
  A second address is added by the member in the web app and confirmed by a one-time link emailed to it.
- **Slack, Teams, Discord.** The request signature proves the provider sent the request; it does not prove which
  Chatticus member the provider user is. The member links the account from the web app with the provider's OAuth sign-in
  (for Slack, "Sign in with Slack", for Teams the Entra identity), and the provider user id is stored against the member.
  Matching by profile email is allowed only as a suggestion that an owner confirms.
- **SMS.** The member adds a phone number in the web app and receives a one-time code by SMS; entering it proves control.
  A phone number links to one member in one organization at a time. SMS sender numbers can be spoofed in some
  conditions, so an SMS-linked member is always limited to the conversational grant.

### 4.3 Email authentication policy (inbound)

SES attaches verdicts to every inbound message. The ingress Lambda requires all of the following for a message to be
treated as authenticated; otherwise the sender is treated as `unknown` regardless of the allowlist:

1. SES spam verdict not FAIL and virus verdict not FAIL.
2. DMARC verdict PASS for the `From` domain. In milestone 1 nothing else authenticates a sender: a DKIM pass alone is
   refused, because the receiver does not say which domain signed, so alignment with the `From` domain cannot be checked
   (the `dkim_aligned` assertion is reserved for milestone 2, when the signing domain is read). SPF alone is never
   accepted because forwarding breaks it and it authenticates the envelope, not the visible `From`. A message with more
   than one `From` header, more than one mailbox in `From`, or a group in `From` is refused as malformed.
3. The `From` address (not the display name, not `Reply-To`) matches a linked member address or a guest admission.
4. The message is not an automated message (section 5).

Domain-wide allowlists ("everyone at example.com is a guest") are allowed only when an owner sets them explicitly and
the domain publishes DMARC `p=quarantine` or `p=reject`. The default is exact addresses. Domain auto-join to the
organization remains excluded, as in [Organizations](ORGANIZATIONS.md).

### 4.4 Webhook authentication (other transports)

| Transport | Check | Notes |
| --- | --- | --- |
| Slack | HMAC-SHA256 of `v0:timestamp:body` with the signing secret; reject timestamps older than 5 minutes; constant-time compare; answer the Events API within 3 seconds and rely on deduplication for Slack's retries | Verify the app and team ids against stored bindings |
| Teams | Validate the Bot Framework JWT (issuer, audience equal to our app id, signature against the published OpenID keys, expiry) | **verify** current Microsoft requirements for new bots |
| Discord | Ed25519 signature over timestamp and body with the application public key; answer PING; respond within 3 seconds with a deferred response | Only interactions arrive |
| SMS | Provider signature (third party) or SNS signature validation plus our topic arn (AWS) | |

Verification happens before parsing the body into events and before any DynamoDB write other than a bounded
rejection counter.

## 5. Abuse and loop prevention

**Automated mail is never answered.** Inbound is dropped from the turn path (and bounces are handled as delivery
status) when any of these hold: empty or null return path; `Auto-Submitted` other than `no`; `Precedence` of `bulk`,
`list` or `junk`; `X-Auto-Response-Suppress`, `X-Autoreply` or `X-Autorespond` present; `List-Id` or
`List-Unsubscribe` present; content type `multipart/report` or a delivery-status part; the sender local part is
`mailer-daemon`, `postmaster` or `noreply` style on a denylist; our own `X-Chatticus-Origin` header present.

**Our own mail says what it is.** Bot replies carry `Auto-Submitted: auto-replied`, `X-Chatticus-Origin` with the
environment, and `X-Chatticus-Hops` with a counter. An inbound message with hops above 3 is dropped; in milestone 1 every message that carries the origin header is dropped,
which covers any hop count. This stops two
Chatticus deployments, or a bot and an external auto-responder that ignores the headers, from looping.

**Bot-to-bot never uses email.** Bots in one organization talk through the channel, as in [Messaging](MESSAGING.md).
A bot that emails another bot's address is a normal external send to a guest.

**Per-thread cap.** At most 5 consecutive bot replies on an external thread with no new message from a human or an
admitted guest, then the bot waits. At most 20 outbound external messages per binding per hour.

**Rate limits (defaults, owner-tunable downward).**

| Scope | Default |
| --- | --- |
| Per external identity per binding | 20 messages per hour, 100 per day |
| Per binding | 200 inbound per day, 100 outbound per day while in the SES sandbox |
| Per organization | 1000 external messages per day |
| Unknown sender, per binding | 50 quarantined messages per day, then drop and count |

**Spend.** Before step 7 of the inbound path the core runs the same organization admission as a web message and also
consumes the binding's **daily external turn budget** (a number of turns and a dollar figure from the cost ledger,
default small, owner-raisable). When either is exhausted the sender gets one polite "temporarily unavailable"
reply per day (not per message) and the message is stored for the owner. This bounds the cost of a compromised or
phished member address.

**Deliverability protection.** A bounce on a permanent failure suppresses that address for the binding. A complaint
suppresses it for the whole organization and disables the binding's outbound until an owner reviews it. A rising
complaint or bounce rate across the account pauses all external outbound in the environment (kill switch) before SES
does it for us. SES account-level suppression for BOUNCE and COMPLAINT is already enabled.

**Prompt injection.** Email, Slack and SMS text is data, never instruction, as in [Threat model](THREAT_MODEL.md).
Messages carry their `origin` into the model prompt so the bot knows the content came from outside and from whom; the
bot's authority does not come from the text. Links in messages are not fetched automatically; images and tracking
pixels are never loaded.

## 6. Approvals and authority

**Rule: no approval is ever accepted from an external channel in this design.**

- An external-origin turn runs with the grant of its trust class: `member` gets the conversational grant a web message
  gets, minus any grant that widens authority; `guest` gets the guest grant.
- A consequential action proposed during an external-origin turn creates an `approval.required` exactly as today. The
  approval card shows the concrete operation. The external channel may be told "I need your approval, open the app" with
  a deep link. The link carries no token and no pre-authorization; the member signs in and decides with a POST.
- An external message can never be the evidence of an approval, a rule, or a ceiling change. "Yes, go ahead" by email
  is just text.
- A bot cannot create or loosen always-allow rules (unchanged). An unattended external-origin turn that reaches a
  consequential class stops visibly or runs only against an exact, human-created rule.
- **Reply in kind** is not a consequential `send` when all of these hold: the prompt origin is an admitted member or
  guest; the recipients are a subset of the thread's existing participants; no new Cc or Bcc; no attachment from the
  workspace; the binding is enabled and not suppressed; limits not exceeded. Everything else is a `send` and is gated.
- The organization `recipients` ceiling already in the policy model is reused as the allowlist for bot-initiated
  external sends.

**Possible later extension (not in the first five milestones):** approve by a signed Slack or Teams interactive button
when (a) the provider user is linked to a member by OAuth, (b) the card shows the concrete operation, (c) the button
callback carries the operation digest and is single-use and short-lived, and (d) the member holds the ceiling. Email
and SMS replies are never eligible.

## 7. Attachments, retention, privacy

- **Raw mail.** SES stores the unmodified message in a per-environment S3 bucket, encrypted, private, with a 30 day
  lifecycle expiry (owner-shortenable). The parsed text lives in the channel (permanent, like any message).
- **Body size.** At most 100 KB of text enters a message; longer bodies are cut and carry a reference to the S3 original.
- **Attachments.** Stored under `attachments/<tenant_id>/<message_id>/` with the same lifecycle. Allowed: documents,
  images, plain text and CSV up to 10 MB each and 25 MB per message (verify against the SES 40 MB message limit).
  Executables and archives are refused and noted. An attachment never reaches the shared computer automatically; a bot
  asks a tool to save it into `/workspace`, which is an ordinary computer action.
- **Outbound attachments** from the workspace are a `send` and gated with the exact file digest.
- **Privacy.** Logs record ids, sizes, verdicts and decisions, never bodies or full addresses (addresses are hashed in
  logs). Quarantine items expire after 14 days. Organization deletion or a member's removal purges bindings, identities,
  quarantine, raw objects and attachments for that tenant. Phone numbers and emails of guests are personal data kept
  only while the admission exists.
- **Unsubscribe.** Outbound mail to guests includes a `List-Unsubscribe`-style reply keyword and the SMS opt-out words
  are honored by both the carrier and our own opt-out list; an opted-out party is never messaged again by that binding.

## 8. Data model additions

No relational store and no migration. New item types in the existing table, all with `tenant_id`:

`binding`, `route` (global lookup), `external_identity`, `admission` (guest or blocked), `quarantine`, `conv`, `emsg`,
`delivery`, `suppression`, `rate_window`. A `ChannelMessageRecord` gains an optional `origin` object
(`binding_id`, `provider`, `external_message_id`, `conversation_key`, `sender_external_id`, `assertion`). An absent
`origin` means the web app, as an absent field is read everywhere else.

## 9. Configuration and secrets

- **Per-organization configuration** lives in the binding record: provider, route key, default bot, enabled, limits,
  allowlist, daily external budget. Only owners create and change bindings; members read them. Stranger requests get 404.
- **Rollout switch**: `external_channels` per organization (default off) and a per-environment kill switch, the same
  pattern as the bot board rollout. Turning a binding off stops inbound admission and outbound delivery and keeps data.
- **Secrets.**
  - Deployment-level values that infrastructure can generate (webhook path secrets, HMAC keys for plus-tags) are created
    by the `GeneratedSecureString` construct from story `chatticus-a17075` as SSM SecureString.
  - Vendor-issued app credentials (Slack signing secret and client secret, Teams client secret, Discord public key and
    bot token) cannot be generated; IaC creates the empty SecureString shell and the owner puts the value once.
  - Per-organization credentials obtained at install time (a Slack workspace bot token) are user data, not IaC. They are
    written at runtime by the front door to an SSM SecureString under `/chatticus/<env>/channels/<tenant_id>/<binding_id>`,
    with the IAM policy of that one role limited to that path prefix (standard tier, default key, 4 KB limit is ample).
    Readers cache for five minutes. Decided (section 16, decision 4).
  - Secrets Manager only where a service requires it.
- **No IAM users or long-lived keys** anywhere. SES, S3, Lambda and EventBridge use execution roles. Deploys keep using
  the OIDC roles.

## 10. Options and recommendation per transport

### 10.1 Email through Amazon SES (recommended first)

**Inbound.** MX for the bot-mail subdomain points at SES inbound in `us-east-1`. A receipt rule with recipient
condition on the environment's mail domain (subdomains included) runs actions: S3 (raw MIME) then Lambda (event
invocation, carrying the SPF, DKIM, DMARC, spam and virus verdicts). Receiving is not limited by the sandbox. Message
size limit for receiving is 40 MB. **Constraint that shapes the CDK:** SES allows one active receipt rule set per
account and region. All three Chatticus environments share the one production account, so one shared stack owns the
rule set and each environment adds its own rule for its own mail domain. `cdk deploy --all` stays forbidden.

**Outbound.** `SendEmail` (SES v2, raw content when headers matter) from the environment's mail domain, through a
configuration set with an event destination (bounce, complaint, delivery, reject) to SNS and then Lambda. Custom MAIL
FROM subdomain for SPF alignment, Easy DKIM, DMARC record on the mail domain. `Auto-Submitted` and origin headers set.

**Addressing options compared.**

| Option | Shape | Verdict |
| --- | --- | --- |
| A. Domain per organization | `researcher AT acme.com` | Best deliverability and brand, needs customer DNS and a DKIM handshake per domain. A later epic (bring your own domain), not first |
| B. Shared subdomain, organization label | `researcher AT acme.mail.chattic.us` with a wildcard MX | **Recommended first.** One verified identity per environment, no per-org DNS, reputation isolated from the marketing domain, easy to reason about |
| C. Shared subdomain, plus-addressing | `acme+researcher AT mail.chattic.us` | Plus tags are stripped by some senders and invite guessing; keep the plus tag only for the thread correlator |
| D. One address, bot named in subject | `team AT mail.chattic.us` | Rejected: ambiguity, no per-bot addressing, no `Cc` semantics |

Domains per environment: `mail.chattic.us` (production), `mail.staging.chattic.us`, `mail.develop.chattic.us`, each a
delegated zone created in the environment's account by CDK, as the site and auth zones are. Organization labels come
from a new owner-chosen `mail_handle` on the organization (lowercase DNS label, unique across the environment,
reserved words refused). Bot handles derive from the unique bot name. The existing verified domain identity
`chattic.us` is left alone because it appears to serve the marketing side; **verify** who owns it before touching it.

**Cost (approximate, verify before building).** SES about 0.10 USD per 1,000 outbound messages and about 0.10 USD per
1,000 inbound messages plus a small per-chunk charge for large messages. One inbound, one answered message costs about
0.0003 USD in SES, Lambda, S3 and DynamoDB. The model turn dominates by two to three orders of magnitude.

### 10.2 SMS (recommended last)

| Option | Shape | Verdict |
| --- | --- | --- |
| AWS End User Messaging SMS (formerly Pinpoint SMS and Voice v2) | Origination number, two-way SMS delivered to an SNS topic, send API, opt-out list, delivery receipts to an event destination | **Recommended.** All in AWS, IAM roles, IaC for most resources (**verify** CloudFormation coverage for numbers and registrations), webhookless |
| Amazon Connect | Contact-center instance with SMS channel | Overkill. It brings an instance, agents, flows and chat pricing for a use that is a text to a named bot |
| Third party (for example Twilio) | HTTPS webhook in, REST out | Faster number provisioning and an easier sandbox, but a second vendor, vendor-issued secrets entered by hand, an external bill, and the same carrier registration. Keep as the fallback if registration with AWS stalls |

**Registration.** US application-to-person traffic needs either toll-free verification or 10DLC brand and campaign
registration. Typical lead times are one to three weeks for toll-free and two to four weeks for 10DLC (**verify**).
New AWS accounts are in an SMS sandbox limited to a handful of verified destination numbers until a production access
request (another request to Amazon, owner-gated). **Recommendation:** one toll-free number per environment, registered
early by the owner while the code is still being written. Number rent is about 2 USD per month per number
(**verify**): this is the only recurring floor in the whole design, accepted explicitly and created only when an
organization turns SMS on.

**Cost.** About 0.008 USD per outbound segment and similar per inbound (**verify**), plus carrier fees. A segment is 160
GSM-7 characters or 70 with any non-GSM character, so the SMS renderer caps a reply at 3 segments and appends a short
link to the full answer in the web app.

**Trust.** SMS is low trust: linked members get the conversational grant only, guests are off by default.

### 10.3 Slack (recommended second)

Slack app distributed by OAuth (no Marketplace listing needed). Events API HTTPS endpoint for `message.im`,
`app_mention` and thread replies; interactivity and slash command endpoints. Outbound `chat.postMessage` with the
workspace bot token and `thread_ts`. Scopes include `chat:write`, `chat:write.customize`, `app_mentions:read`,
`im:history`, `im:read`, `users:read`. Socket Mode is excluded (persistent socket). Rate limits are per method, so the
outbound path honors `Retry-After`. Cost: no per-message fee. Owner action: create the Slack app (outside AWS).

### 10.4 Microsoft Teams (recommended third)

Azure Bot resource and Entra app registration (outside AWS, owner action, **verify** the current single-tenant and
multi-tenant rules for new bots), messaging endpoint on our HTTPS ingress, JWT validation, replies via the Bot Connector
REST API using a client-credentials token, conversation references stored per binding for proactive messages. Tenant
admin consent is needed in each customer tenant, so this is heavier to onboard than Slack. Team channels require an
@mention; personal chats do not.

### 10.5 Discord (deferred)

HTTPS Interactions endpoint (Ed25519 verified) delivers slash commands, buttons and modals only. Ordinary channel
messages and mentions need the Gateway websocket, which this architecture forbids. A slash-command-only Discord bot
(`/ask bot message`, answered with a deferred response and follow-up webhook within 15 minutes) is possible, and
outbound posting by bot token works, but the experience is poor next to Slack. Defer until there is demand; the port
makes it a small adapter later.

### 10.6 Others

Telegram (HTTPS webhook, bot token) and WhatsApp (business API, template rules, registration) are possible adapters
behind the same port. Not planned. A generic signed inbound webhook and outbound webhook binding is a later option for
integrations.

## 11. SES sandbox and production access (read-only facts, 2026-10-21)

Observed with read-only calls in the production account, `us-east-1`:

- Production access: not enabled. The account review status is DENIED (denied once).
- Limits: 200 messages per 24 hours, 1 message per second.
- Sending is enabled. One verified domain identity (`chattic.us`) with Easy DKIM successful; no per-address identities.
- No receipt rule sets and no configuration sets exist yet. Account-level suppression of BOUNCE and COMPLAINT is on.
- DNS: `chattic.us` is served from the management account, with environment zones delegated; the zone carries a DMARC
  record with `p=none`. No MX record exists at the apex.

**What the sandbox allows (so milestone 1 is real):**

- Inbound receiving works normally. Anyone may send mail to the bot-mail domain.
- Outbound only to verified email identities (and to the SES mailbox simulator: `success@`, `bounce@`, `complaint@`,
  `ooto@`, `suppressionlist AT simulator.amazonses.com`). The simulator lets the live smoke test exercise bounce and
  complaint handling without harming reputation.
- A reply to an unverified sender fails. In the sandbox, test users must be verified identities.

**Milestone 1 setup:** a mail subdomain identity for development, the owner's own addresses and approved testers
verified as identities (a verification email each, sent by SES; no Amazon request), `Auto-Submitted` and headers in
place.

**What production access unlocks:** sending to any recipient without per-address verification, and higher limits (a
requested starting quota, then automatic ramp). That is what lets a bot answer a new guest and what a real
organization needs.

**When to ask (owner decides):** not before milestone 2 is complete in development. The request should describe
the use case (transactional replies from named bots to people who wrote to them first), the opt-in basis (the person
emailed the bot first; guests are admitted by an owner), bounce and complaint handling, the suppression list, the
rate limits, and the unsubscribe path. The task that prepares the written request is a draft only; the owner files it.
A second denial is likely if there is no real activity or the mail looks like marketing, so ask when there are approved
test users and logs to point at.

## 12. Cost summary

| Item | Estimate |
| --- | --- |
| Email, per answered message | about 0.0003 USD infrastructure |
| Email idle floor | zero (S3 storage of retained raw mail is cents) |
| Slack, Teams | zero per message |
| SMS per message | about 0.008 to 0.02 USD per segment each way, plus carrier fees (verify) |
| SMS idle floor | about 2 USD per month per toll-free number, per environment that enables it (verify) |
| One-time registrations | toll-free verification free; 10DLC brand and campaign fees if chosen (verify) |
| Dominant cost | the model turn the message starts, already covered by ceilings |

## 13. Observability and acceptance

- **Metrics** (CloudWatch embedded metrics, no bodies): inbound received, accepted, quarantined, rejected by reason,
  deduplicated, filtered as automated; outbound sent, failed by class, bounced, complained; delivery latency;
  quarantine depth; rate-limit and budget refusals.
- **Alarms** (existing alarm topic): complaint rate, bounce rate, ingress Lambda errors, delivery sweeper backlog,
  outbound disabled by kill switch.
- **Audit**: admissions, blocks, binding changes and quarantine decisions are recorded with who and when.
- **Acceptance runner** (`conversation/bin/acceptance.ts --environment`): a new `external-email` check that (1) posts a
  recorded raw message through the ingress test entry point under a dedicated test tenant and expects a message and a
  turn, (2) sends an answer to the SES success simulator and expects `sent`, (3) sends to the bounce simulator and
  expects `bounced` and a suppression, and (4) proves a stranger message is quarantined with no turn. A real
  inbound round trip with an owner-verified address stays a documented manual step because the simulator is outbound
  only.

## 14. Milestones

| Milestone | Epic | Outcome |
| --- | --- | --- |
| M1 | Channel transport port and email in the SES sandbox | Port, fake transport, binding service, inbound and outbound for email, development environment live with one verified test address |
| M2 | Identity, authorization and abuse controls; production-ready email | Trust classes, authentication policy, quarantine, loop prevention, limits, deliverability handling, retention, observability, owner web panel, readiness gate for SES production access |
| M3 | Slack | OAuth install, Events API, thread mapping, identity linking |
| M4 | Teams (and Discord, deferred) | Bot Framework adapter; Discord slash-command adapter only if requested |
| M5 | SMS | Registration (started early), End User Messaging adapter, phone verification, opt-out, segments |

Dependencies: M2 depends on M1. M3 and M4 depend on M2 (identity and abuse controls apply to every transport). M5
depends on M2; its carrier registration task has no code dependency and starts as soon as the owner agrees. The
secrets story `chatticus-a17075` (the `GeneratedSecureString` construct) should land before the first task that needs a
generated secret.

## 15. Risks

| Risk | Mitigation |
| --- | --- |
| SES production access is denied again | M1 and M2 work fully in the sandbox; ask only with activity and approved test users; the port would allow another outbound email adapter if ever needed |
| One active SES receipt rule set per region | Shared mail-ingress stack owns the set; per-environment rules; tests assert rules for other environments are untouched |
| Spoofed or phished senders consuming spend | Authentication policy, exact-address allowlists, daily external budget, ceilings |
| Mail loops | Auto-submitted detection, hop counter, per-thread cap |
| Prompt injection through inbound text | Data-not-instruction rule, no approvals from channels, guest grant, no automatic link fetching |
| Reputation damage | Complaint and bounce suppression, kill switch, separate mail subdomain from marketing |
| Slack 3 second ack | Ack after one DynamoDB write; work happens in the existing turn path |
| Carrier registration lead time | Owner starts it at the beginning of M2 |
| Per-tenant provider tokens in SSM written at runtime | Decided (section 16, decision 4); the alternative was DynamoDB with a customer-managed KMS key (about 1 USD per month) |
| Teams and Discord platform rules change | Both are behind the port, both come after Slack; each has a verification task before code |

## 16. Owner decisions

The owner answered the seven planning questions on 2026-10-25. Each is a decision, not a recommendation.

1. **Address shape.** `bot AT org.mail.chattic.us`: a shared subdomain per environment, an organization label, a
   wildcard MX. Bring-your-own-domain is a later epic.
2. **Sandbox testers.** The owner's own address plus one or two approved testers. Tests use only the in-memory fake
   transport and the SES mailbox simulator. No test sends real outbound mail.
3. **Production access timing.** The owner files the SES production access request after milestone 2 is complete in
   development. The code and the planners never ask Amazon for anything.
4. **Per-organization provider tokens.** Written at runtime to SSM SecureString under a path-scoped role
   (`/chatticus/<env>/channels/<tenant_id>/<binding_id>`).
5. **SMS number and registration.** The number purchase and the carrier registration are an owner-run task. No agent
   does any of it.
6. **Guests.** Members first. Admitted guests come last in milestone 2, because the guest grant is the riskiest part.
7. **Rollout.** The `external_channels` switch is turned on first for the operator organization only.

## 17. Milestone 1 as built

What exists, so a later reader does not have to infer it from the code:

- **Port and core.** `conversation/src/channels/transport.ts` is the port of section 2.2. `inbound-admission.ts` is the one
  inbound path, `delivery.ts` the one outbound path, `conversation-mapping.ts` the mapping of section 3, and
  `fake-transport.ts` the in-memory transport every feature uses. There is no SES adapter yet.
- **Switches.** The operator turns `external_channels` on or off per organization with
  `POST /operator/orgs/{tenant_id}/external-channels/{enable,disable}`. The per-environment kill switch is a field of the
  channel runtime the deployment builds. Where the runtime is absent, or the organization is not switched on, every
  binding route answers 404 as if it did not exist.
- **Owner routes.** `PUT /orgs/{tenant_id}/mail-handle`, `POST|GET /orgs/{tenant_id}/channel-bindings`,
  `GET|PATCH /orgs/{tenant_id}/channel-bindings/{binding_id}`, `GET .../deliveries` and
  `PUT /orgs/{tenant_id}/external-identities`. Owners change, members read, role is read from the membership at every
  request. Disabling a binding keeps all of its data and stops admission and delivery.
- **One linked sender.** Milestone 1 knows one kind of sender: an external identity an owner linked to a member. Every
  other sender is dropped and counted. Quarantine, guests and the authentication policy belong to milestone 2.
- **Items.** Binding, settings, identity, `conv`, `emsg` and inbound-claim items live under `{tenant_id}#channels`; the
  reply deliveries and their open entries live under `{tenant_id}#channels#deliveries`, a partition the turn owner role
  may write; the global lookups are `route#<provider>#<route key>`, `mailhandle#<handle>` and
  `dmsg#<provider>#<provider message id>`. No schema migration.
- **Origin.** The message `origin` block travels through the mailbox item, the channel log line and the message listing,
  and the HTTP message payload renders it as `origin`. Its absence means the web app.
- **Delivery.** `commitFinalAnswer` records the delivery and publishes an event with the tenant, message and binding ids
  only. The delivery handler, the sweeper (five attempts, a three minute stale age) and the provider status path are
  functions of `delivery.ts`; the rule that invokes the delivery handler, the Lambda entry points and the scheduler arrive
  with the SES adapter and Lambdas task (M1.8), because no delivery handler Lambda exists yet.
- **Deployment wiring.** `lambdas/channels-composition.ts` builds the runtime from environment variables. External
  channels exist in a deployment exactly where `CHATTICUS_CHANNELS_MAIL_DOMAIN` is set, which the control plane stack
  does where the mail stack is built (development only). The same deployment must name the event bus
  (`CHATTICUS_CHANNELS_EVENT_BUS_NAME`, the account's default bus) and the SSM SecureString that holds the plus-tag secret
  (`CHATTICUS_CHANNELS_CORRELATOR_SECRET_PARAMETER_NAME`, `/chatticus/<env>/channels/correlator-secret`, generated once by
  `GeneratedSecureString`, read by the front door only through `ssm:GetParameter` on that exact ARN). The kill switch is
  `CHATTICUS_CHANNELS_KILL_SWITCH`, engaged when absent; development releases it, and the per-organization switch decides
  the rest. The turn executor records a reply delivery and publishes the `channel.message.created` event through a
  recorder that checks both switches on every reply; its role holds `events:PutEvents` on the default bus and nothing
  else on events. The transport map holds the email adapter, which cannot render or send until M1.6 and M1.8.
- **Same-organization access to a channel.** A member who is not a participant of an external channel is refused with
  403 by the same participant check every channel uses, not 404. A caller who is not a member of the organization at all
  is refused with 403 by the organization membership check every organization route uses, with the same answer for an
  existing and a missing channel; only the owner binding routes answer 404 to non-members.

### Known gaps for M2

These are decided, observed and deliberately left open in milestone 1. Each has a board task.

- **In-flight inbound.** While a message is claimed and not yet completed, a repeated delivery of it is dropped as
  `in_flight` and counted as `inbound_duplicate`. The ingress for a real provider must answer that case with a non-2xx
  status so the provider retries after the claim lease (60 seconds); answering 2xx would lose the message if the first
  attempt died. The core reports `in_flight`; the ingress must map it.
- **Finalize crash window.** `commitFinalAnswer` commits the reply and then records the delivery and publishes the
  event. A crash between the commit and the delivery record leaves a committed reply with no owed delivery, and the
  sweeper cannot see it because it lists open deliveries only. Closing the window needs the delivery recorded in the same
  write as the commit, or a reconciliation pass over replies of external turns.
- **Own outbound Message-ID check.** An inbound message whose Message-ID is one of our own outbound ids should be
  dropped and counted. The outbound id format is not defined yet; the outbound rendering task (M1.6) defines it, and the
  inbound check lands with it. Until then only the `X-Chatticus-Origin` header marks our own mail.
- **Raw MIME parser version.** The parser dependency is pinned to a version with a published advisory about many encoded
  words in one header. It is mitigated by explicit parser limits (header size, nesting depth, part count) and a refusal
  scenario; a bump to a patched version waits until it is at least two weeks old and has a board task.
- **Same-organization Message-ID reuse.** Conversation keys are scoped to the sending member so one member reusing
  another member's Message-ID neither suppresses nor joins that member's thread, and the inbound deduplication key
  includes the sender.
