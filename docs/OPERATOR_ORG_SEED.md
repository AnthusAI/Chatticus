# Operator organization seed

Organization records are DynamoDB data, not CDK infrastructure. An operator
with AWS credentials and the messaging table name can bootstrap the first
enabled organization before route enforcement lands in Kanbus **7b4616**.

Enable and seed are **status-only**: they never call `ensure_computer` and
never start Fargate. Deploy with `computerCount=0`. Never run
`cdk deploy --all`.

## Prerequisites

- AWS credentials for the target deployment account.
- `CHATTICUS_MESSAGING_TABLE` set to that environment's messaging table
  (for example the `ChatticusThinTurn-Messaging...` table from the thin-turn
  stack).
- Python env from `python/` with `pip install -e ".[dev]"`.
- The owner's **verified Google email**, passed on every command as
  `--owner-email`. Never commit a real address in this repository.

## Browser sign-in (not in this card)

Seeding writes identity, organization, and membership rows only. Reaching the
web app instead of the waitlist after Google sign-in still depends on human
OAuth client registration (**0ab02c**), Cognito federation, `GET /me`, and
app branching (**22f5bb**). Do not fake OAuth or wire `resolve_principal`
here.

After **0ab02c** lands, the same normalized email used in `--owner-email`
must resolve to the seeded identity so membership checks succeed.

## First organization (anthus)

Chatticus v1's first enabled organization is tenant `anthus` with display name
**Anthus AI Solutions**. The seeded owner is keyed on verified Google email in
lowercase (`ryan@anth.us`). Use `seed`, not `create`, so the tenant id is
`anthus` rather than a minted UUID. On an empty environment `seed` writes
`enabled` directly; on environments with legacy messaging rows it aligns the
owner identity with the existing `ryan` user id.

```bash
export CHATTICUS_MESSAGING_TABLE=<messaging-table-name>

python -m chatticus.members seed \
  --tenant-id anthus \
  --owner-email ryan@anth.us \
  --name "Anthus AI Solutions" \
  --yes

python -m chatticus.members show anthus
python -m chatticus.members list --status enabled
```

Confirm `status=enabled`, `name=Anthus AI Solutions`, and owner email keyed
as `ryan@anth.us`. The seed records `aws_account_id` from the STS caller
identity of the operator credentials running the command (not a default
placeholder). No computer row is created.

**Migration:** Organizations seeded before this change may have
`aws_account_id=None`. Computer start refuses until `members seed` is
re-run for `anthus` (or the tenant) with live AWS credentials so the
home account is recorded.

## Cold bootstrap (empty org records, arbitrary tenant)

Use this on a fresh environment or to prove the escape hatch with no web
session:

```bash
export CHATTICUS_MESSAGING_TABLE=<messaging-table-name>

python -m chatticus.members create \
  --owner-email <verified-google-email> \
  --name "Bootstrap Labs" \
  --yes

python -m chatticus.members list --status pending

python -m chatticus.members enable <tenant_id-from-create-output> --yes

python -m chatticus.members show <tenant_id-from-create-output>
```

`create` mints a UUID `tenant_id` in `pending` status. `enable` moves it to
`enabled` without provisioning a computer.

## Tenant backfill (existing messaging rows)

Development, staging, and production already hold bots, channels, turns, and
tasks under tenant `anthus` with user `ryan`. Org records live under the
`anthus#org` prefix and do not overwrite messaging partition keys.

```bash
export CHATTICUS_MESSAGING_TABLE=<messaging-table-name>

python -m chatticus.members seed \
  --tenant-id anthus \
  --owner-email <verified-google-email> \
  --yes

python -m chatticus.members show anthus
```

Behavior:

- `--tenant-id` names the organization partition to seed (for example
  `anthus`).
- The command reads messaging rows in that tenant and aligns the owner
  identity with the single `user_id` already present (for `anthus`, that is
  still `ryan`).
- If the tenant has **multiple** messaging user ids, the command fails
  loudly.
- On first sight of the email, identity uses that legacy `user_id`.
- If the email already maps to a **different** `user_id`, the command fails
  loudly instead of splitting identity from legacy data.
- Writes `enabled` directly (or enables an existing pending org).
- Sets `aws_account_id` to the AWS account id returned by STS
  `get_caller_identity` for the operator credentials running seed.
- Re-running is idempotent when owner and status already match.
- Never provisions a computer.

Optional display name (default: tenant id):

```bash
python -m chatticus.members seed \
  --tenant-id anthus \
  --owner-email <verified-google-email> \
  --name "Anthus AI Solutions" \
  --yes
```

## Verification

After seeding:

```bash
python -m chatticus.members show anthus
python -m chatticus.members list --status enabled
```

Confirm `status=enabled`, owner `user_id=ryan` for the `anthus` example, and
no computer row created by seed for that owner. Existing bots and channels
under `anthus` / `ryan` should remain readable through the control plane
unchanged.

## HTTP API for external callers

External systems (for example the private SaaS billing layer) can enable,
suspend, and reinstate organizations through the authenticated operator HTTP
API instead of shell access to the members CLI.

```http
POST /operator/orgs/{tenant_id}/enable
POST /operator/orgs/{tenant_id}/suspend
POST /operator/orgs/{tenant_id}/reinstate
Authorization: Bearer <operator-key>
```

The operator bearer is deployment-wide. It is stored in Secrets Manager as
`OperatorKey` and injected into the thin-turn Lambda as
`CHATTICUS_OPERATOR_KEY`. The CloudFront invoke key is still required at the
edge when configured; it is not operator identity.

Self-hosters with AWS credentials and `CHATTICUS_MESSAGING_TABLE` can keep
using `python -m chatticus.members` for the same transitions. The CLI and the
HTTP API are two callers of one control-plane implementation.

## What not to do

- Do not edit Dynamo rows by hand except through this CLI.
- Do not use `enable` to unsuspend; it accepts `pending` only.
- Use `reinstate` to move a suspended organization back to `enabled`.
- Do not run `cdk deploy --all`.
- Do not set `computerCount` above zero for this workflow.
