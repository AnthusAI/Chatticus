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

## Cold bootstrap (empty org records)

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
- Re-running is idempotent when owner and status already match.
- Never provisions a computer.

Optional display name (default: tenant id):

```bash
python -m chatticus.members seed \
  --tenant-id anthus \
  --owner-email <verified-google-email> \
  --name "Anthus Labs" \
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

## What not to do

- Do not edit Dynamo rows by hand except through this CLI.
- Do not use `enable` to unsuspend; it accepts `pending` only.
- Do not run `cdk deploy --all`.
- Do not set `computerCount` above zero for this workflow.
