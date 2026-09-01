# Budgets (v1)

Every Chatticus deployment ships with its own budget tracking, alerts,
notifications, and configurable limits. This is how spend is metered
without double counting, and what a deployment must carry to be
self-contained.

## The invariant

> **Tokens are always counted. Dollars are counted once, by whoever
> issues the invoice.**

Two meters. Every cost belongs to exactly one, and the meter is chosen by
**billing path**, never by category.

| Meter | Covers | Mechanism | Separated per deployment by |
| --- | --- | --- | --- |
| AWS | Everything on the AWS invoice, model inference included | AWS Budgets and Cost Explorer | The AWS account |
| Vendor | Model spend AWS cannot see | Our ledger in DynamoDB | A per-deployment vendor project |

"How much are we spending on AI" is a **report**, not a meter. It is
assembled from both. Making it a meter is what double counts anything
billed through AWS.

## Why Bedrock is the whole problem

Bedrock is model inference on the AWS invoice. It is the only case where
the two axes cross, and exactly where a naive design counts twice: the
token meter records it because it is a model call, and AWS Budgets
records it because Amazon billed for it.

The rule follows from the invariant. **Bedrock belongs to the AWS meter.**
The ledger still writes a row for a Bedrock turn, because tokens are
always counted and we need them for rate limiting and apportionment. That
row carries `billed_via: "aws"` and `cost_usd: null`.

One nullable field and one enum keep the books straight, and both must
exist **before** Bedrock lands. Adding them afterwards means reconciling
a period where the answer was wrong and nobody could tell.

## One account per deployment

Each deployment gets its own AWS account. The account boundary does the
heavy lifting that tags would otherwise do badly: a client's AWS spend is
that account's spend, full stop. No apportionment, no tag hygiene
standing between us and a correct number, and no risk that one client's
runaway cost hides inside another's baseline.

That boundary covers the AWS meter completely. **It does nothing for the
vendor meter.** OpenAI does not know what an AWS account is. Vendor spend
is separated only by giving each deployment its own vendor project and
key, and a deployment that shares a key with another one has vendor spend
that cannot be attributed to either.

Today `infra/lib/thin-turn-stack.ts` reads the OpenAI key from
`/amplify/shared/papyrus/OPENAI_API_KEY`, a shared parameter belonging to
a different product, referenced in five places. In a new dedicated
account that parameter does not exist and the stack does not deploy. It
is both the first blocker for a dedicated account and the reason vendor
spend is currently unattributable.

## Configurable limits

Limits are deployment configuration, not constants. A `ChatticusBudgets`
construct takes a monthly limit, alert thresholds, and notification
targets, with defaults that suit a small deployment and an override per
environment.

A new account has no history to derive a limit from, and that is a
feature. Start low enough that any spend is signal and raise it
deliberately, rather than starting high and learning what normal was
after an invoice. Historical spend from a previously shared account is
not a baseline for a fresh one and should not be used as one.

## Cost allocation tags

With one account per deployment, tags stop being what separates clients
and become what breaks a single client's spend down internally.

| Tag | Values | On |
| --- | --- | --- |
| `chatticus:environment` | development, staging, production | Per-environment stacks |
| `chatticus:component` | front-door, computer, web, snapshots, dns | Every stack |
| `chatticus:tenant` | An organization's `tenant_id` | Organization-attributable resources |

The third one still pays for itself: a computer is organization-wide, so
tagging the summoned Fargate task with its `tenant_id` makes
per-organization cost a Cost Explorer query rather than something we
build.

Two honest limits. A cost allocation tag does not appear in Cost Explorer
until activated in the Billing console, and **activation is not
retroactive**, so it belongs in the deployment runbook rather than in
someone's memory. And `ChatticusSnapshots` and `ChatticusComputers` are
deliberately not per-environment, so they are reported as a shared
remainder rather than apportioned by guesswork.

## Combining the two meters

No always-on aggregator; that reintroduces the idle floor the whole
architecture avoids. EventBridge Scheduler already wakes a Lambda for
turn deadlines, and a daily budget rollup is the same shape: a routine
wake-up, not something in the token path.

Once a day a function reads Cost Explorer for the AWS side and the ledger
for the vendor side, writes one rollup row per day per organization and
per environment, and publishes to SNS when a threshold is crossed. AWS
Budgets fires its own native alerts to the same topic, and the rollup
records that an alert fired, so a human sees one sequence rather than two
disconnected emails whose relationship they must reconstruct.

A brand-new account reports nothing for roughly a day while Cost Explorer
populates. Say so in the runbook, or the first quiet day reads as a
broken alarm.

## Per-organization attribution

Tagged AWS resources attribute cleanly. Vendor spend attributes cleanly,
because the ledger is written per turn and a turn belongs to an
organization.

**Bedrock does not.** A Bedrock invocation does not carry our tenant tag,
so Cost Explorer can total it and cannot split it. Two ways out, in
preference order:

1. Application inference profiles, which can carry tags. Confirm they
   support cost allocation before building on it.
2. Apportion the Bedrock total across organizations by the token counts
   already in the ledger. Approximate, and honest about being so.

Per-organization cost is what billing needs in v3. An attribution gap
found then costs far more than one designed around now.

## Still open

- Whether client accounts sit under one AWS Organization with
  consolidated billing, or stand alone with the client paying AWS
  directly. This decides who receives budget notifications, whether we
  can see spend across clients at all, and who holds the payment method.
- Whether each deployment gets its own vendor account or a project inside
  ours. Separate projects are enough for attribution; separate accounts
  also separate liability and rate limits.

## Not in scope

- Charging anyone. The boundary billing needs is built here; the invoice
  is not.
- Per-user budgets inside an organization. The organization is the unit
  of spend, as it is the unit of enablement.
- Reserved capacity, savings plans, or any commitment purchase.
