# Role access guard

Why this exists: the in-memory and moto-backed stores that every scenario runs on enforce no IAM policy. A request that
real AWS refuses, or answers differently (a read of a missing S3 key is 404 only when the caller may list the bucket and
403 otherwise), passes every test. The guard makes the real policy documents part of the offline gate.

## The pieces

| Piece | What it holds | Where |
| --- | --- | --- |
| Role access manifest | One row per request shape a role makes: role, action, store, key pattern, an example key | `conversation/src/gateway/role-access-manifest.json` |
| Recording clients | Note every DynamoDB and S3 request the Front Door, the per-turn owner and the supervisor send through the stores, and mark a read of a key S3 reported missing | `conversation/features-support/aws-request-recorder.ts` |
| Coverage hook | After every cucumber scenario, each recorded request must match a row of its role | `conversation/features-support/hooks.ts`, `role-access-coverage.ts` |
| Manifest scenarios | The JSON policy files allow every row; a request without a row fails and names role, action, key; the 404-against-403 rule | `features/role_access_manifest.feature` |
| Synthesized-policy test | Every row is evaluated against the policy documents CDK synthesizes for the Front Door, the owner scoped role and the supervisor role | `infra/test/role-access-policy.test.ts` |
| Post-deploy simulation | The same rows put to `iam:SimulatePrincipalPolicy` for the deployed roles (read-only) | `conversation/bin/simulate-role-access.ts` |

The turn executor Lambda is a fourth role, `turnExecutor`: its one row is `events:PutEvents` on the `channelEventBus` store (the
EventBridge bus of the reply-delivery event), and it is denied the three secret parameters. It makes no recorded request, so the
coverage hook has nothing to match for it.

The roles: `frontDoor` (the Front Door Lambda role, all of its CDK grants and the snapshot statements), `ownerTurn` (the
per-turn owner role, `owner-role-policy.json`), `supervisor` (`supervisor-role-policy.json`).

## What a new access path does

1. The code touches a new S3 key shape or DynamoDB partition. A scenario that exercises it records the request; the
   hook fails the scenario with a sentence like
   `frontDoor made s3:PutObject on piSessionsBucket key conversations/..., which role-access-manifest.json does not list: add a row for it, then make the role's policy allow it`.
2. Add the row to the manifest (the action, the store, a `keyPattern` that every real key satisfies, an `exampleKey` with
   `{tenantId}`, `{botId}`, `{channelId}`, `{computerId}` and `{turnId}` standing for the example scope).
3. The infra test evaluates the row against the synthesized policy of its role. Without an allowing statement it fails with
   `... is denied by the policy`. Add the statement (in the JSON policy file for the owner, supervisor and Front Door
   snapshot access, or in the CDK grant for the rest of the Front Door).
4. An object read (`s3:GetObject`) is also asked what S3 answers for a missing key. Unless the row says
   `keyAlwaysExists: true` (with a `note` saying why), the role must hold `s3:ListBucket` on the bucket with no
   `s3:prefix` condition, or the row fails with `would answer 403 AccessDenied for a missing key`. A recorded read of a
   missing key on a `keyAlwaysExists` row fails too.

## Limits

The hook judges only requests that scenarios make through a recording client, so a path no scenario exercises is not seen:
a feature that adds one adds the scenario first. The Front Door's own Messaging-table access is not recorded (the stores
the Front Door shares with the scenario setup are not wrapped), only its message listing, snapshot reads and edit overlay.
The simulation covers the rows the manifest lists, nothing else. No part of this calls AWS in CI.
