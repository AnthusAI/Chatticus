# Promoting the TypeScript architecture to main

Status: proposal for owner approval. Nothing in this document has been executed.
Read-only assessment taken against `origin/develop` at b902f5d3 and `origin/main`
at e68b5f4f on 2026-10-13. No account ids, secret values or ARNs appear here; take
them from `AGENTS.local.md` (absent in the assessing worktree).

## 1. Bottom line

Do not merge `develop` into `main` yet. A plain merge would, in one motion:

1. Tag and publish a **v1.0.0** release (semantic-release finds no reachable tag),
   then fail its own pre-1.0 guard after the tag already exists.
2. Fire nine staging and production deploy workflows with **no approval gate and
   no branch protection** (by decision of the owner, 2026-10-15: friction-free, no protection). By code reading, most jobs fail fast, and one class
   (auth) redeploys legacy stacks from new code. None deploys the TypeScript
   control plane to a working staging or production, because those environments
   were never bootstrapped for it.
3. Break the **private marketing site's** build (it `pip install`s
   `node_modules/chatticus/python`, which the merge deletes) and put the live
   marketing waitlist and contact forms at risk (their `/api` is the legacy
   Python production thin-turn Lambda that the TypeScript control plane
   deliberately does not replace).

Promoting is mostly a **gating and sequencing** problem, not a code problem. The
code on `develop` is green. The plan in section 8 does the safe things first:
protect `main` and the environments, change what a push to `main` does, fix the
release baseline, decouple the website, and only then merge. Staging and production
cutover to the TypeScript control plane is a separate, later, human-run phase.

## 2. How far apart the branches are

Evidence: `git rev-list --left-right --count origin/main...origin/develop` gives
`52 691` (main has 52 commits develop lacks, develop has 691 main lacks). Merge
base is ee27393d. The 52 main-only commits are Python-era release commits
("0.41.0" style) and merge commits; `git diff --stat origin/main...origin/develop`
is 1723 files, +262781 -52971.

| Area | main | develop |
| --- | --- | --- |
| `python/` | present (191 files, the Python control plane, also the semantic-release project) | deleted |
| `conversation/` | absent | present (507 files, the TypeScript control plane on Pi-durable) |
| `host-protocol/`, `computer/host/` | absent | present |
| `.releaserc.json` | absent | present (JS semantic-release) |
| Workflows | 11 (ci, semantic-release, nine deploy-{web,thinturn,auth}-{env}) | 16: adds `deploy-controlplane-{env}` x3, `build-computer-image-development`, `verify-account-deploy-role`; CI replaces the Python job with a `conversation` job (moto, vitest, cucumber-js) |
| `features/` | behave-era Gherkin | 91 added, 73 deleted, 30 modified (cucumber-js manifest) |
| `infra/` | legacy single-account stacks | adds dedicated-account stacks, ControlPlane stack, zones, certificates, management DNS, tagging; thin-turn stack drops the Python Lambdas (about -460 lines); `integration-test-stack` and `sse-spike-stack` deleted |
| `project/` (Kanbus) | older board | 287 files added, 57 modified (board is carried by the promotion) |
| Root `package.json` | workspaces web, infra; version 0.1.0 | adds workspaces conversation, host-protocol, computer/host; adds semantic-release devDependencies |

So main still ships the Python control plane (the `python/` tree, `behave`, the
Python semantic-release). Staging and production run it too (README "The control
plane is TypeScript on develop").

## 3. Release and version a merge would produce

Config on develop (`.releaserc.json`): branch `main`, tag format `v${version}`,
conventionalcommits preset, `releaseRules: [{ breaking: true, release: "minor" }]`,
changelog, npm (no publish), git (commits `package.json`, `package-lock.json`,
`CHANGELOG.md` with `[skip ci]`), GitHub release. The workflow runs on a successful
CI run on a push to `main` whose actor is not a bot, and its `guard-pre-1-0` job
fails any release that is not `0.*`.

Commits on develop not on main, by type: pm 446, feat 83, fix 47, docs 17, chore 16,
test 14, spike 5, ci 4, web 2, infra 2. There are **zero** `BREAKING CHANGE` footers
or `!:` subjects, and breaking changes map to minor anyway. Analysis alone would
say a minor bump (0.44.0).

**The trap:** all 48 tags (latest v0.43.0) point at commits that are ancestors of
neither `main` nor `develop` (`git tag --merged origin/main` is empty;
v0.43.0 is on 4643ba29, which no remote branch contains). semantic-release only
counts tags reachable from the branch, so on the first release it will see no prior
release and compute **1.0.0**. It publishes the tag, the release commit and the
GitHub release first; `guard-pre-1-0` then fails the run. Result: a public v1.0.0
tag and release that the owner then has to delete.

Mitigation, required before the merge: put a reachable baseline tag on main's
current head (for example `v0.43.1` on e68b5f4f, "last Python release"). Then the
analyzer sees only develop's commits since the baseline and proposes v0.44.0. Also
note the release job will commit a large generated `CHANGELOG.md` to `main`.

## 4. What a push to main triggers

All of these are `on: push: branches: [main]` plus `workflow_dispatch`, taken from
develop's versions (the merge replaces main's). Staging jobs share concurrency group
`deploy-staging`, production jobs `deploy-production`; they queue serially, none
cancels.

| Workflow | Environment | Steps run |
| --- | --- | --- |
| ci | none | infra tests and synth, web test/lint/typecheck/build, conversation typecheck, vitest, cucumber |
| semantic-release | none | tag, changelog commit, GitHub release (see section 3) |
| deploy-controlplane-staging / -production | staging / production | `dedicated-account.sh ENV control-plane` |
| deploy-web-staging / -production | same | `dedicated-account.sh ENV control-plane`, then `deploy-chatticus-web-ENV.sh` |
| deploy-thinturn-staging / -production | same | `dedicated-account.sh ENV control-plane`, then `deploy-chatticus-web-ENV.sh`, then `deploy-chatticus-thinturn-ENV.sh` |
| deploy-auth-staging / -production | same | `deploy-chatticus-auth-ENV.sh` only |

Inputs they need: environment secret `AWS_DEPLOY_ROLE_ARN` (exists on all three
GitHub environments), repo variable `CHATTICUS_INSTALLATION_NAME` and repo secret
`CHATTICUS_BUDGETS_NOTIFICATION_EMAIL` (both exist at repo level), environment
variable `CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD` (exists on staging and production).
`AWS_NEW_ACCOUNT_DEPLOY_ROLE_ARN` exists per environment but is used only by
`verify-account-deploy-role.yml`.

What each does, by code reading (I cannot read the secret to confirm which account
`AWS_DEPLOY_ROLE_ARN` targets; Kanbus chatticus-7ebd57 and `infra/README.md` say it
is deliberately still the legacy account until a cutover card, and the Oct 3 main
deploys that succeeded used legacy scripts):

- `dedicated-account.sh` **refuses** any account that has the legacy `ChatticusDns`
  stack. With a legacy role, the first step of controlplane, web and thinturn jobs
  exits 1 and the job stops before any stack changes. Safe, but only by accident of
  ordering.
- `deploy-auth-staging/production` do not go through that guard. They run
  `cdk deploy ChatticusAuth{Staging,Production} --exclusively` in the legacy account
  with develop's infra code (`auth-stack.ts` changed by 14 lines, `web-build-env.ts`
  and `tagging.ts` also changed). That redeploys the live Cognito stacks. Low risk,
  but it is an unreviewed change to production auth.
- If anyone repoints `AWS_DEPLOY_ROLE_ARN` to a dedicated account before the
  environment is bootstrapped, the control-plane step would run, and then the web and
  thin-turn scripts (which are legacy-shaped and do not pass
  `chatticusAccountEnvironment`) would try to deploy legacy-shaped stacks into the
  new account. The workflows are internally inconsistent about which account model
  they target; they must be reconciled before production is ever deployed from them.
- The thin-turn stack on develop no longer defines the Python Lambdas. Deploying it
  into the legacy account would delete the Python control plane that staging and
  production run today (the `Messaging` table is `RETAIN` with point-in-time recovery).

## 5. Bootstrap state of staging and production

From Kanbus (chatticus-7ebd57, chatticus-d6997c, chatticus-2e4d79, chatticus-c649bf),
the infra README and the repo:

| Item | development | staging | production |
| --- | --- | --- | --- |
| AWS account exists | yes | yes (the production account, shared with production; see section 11) | yes |
| Budgets, Snapshots, Computers, thin-turn data stack in the new account | yes | no: staging is added to production's account, which already holds them (one 100 USD budget for both; section 11) | yes (100 USD placeholder) |
| Zones, certificates, DNS delegation | yes (`develop.chattic.us`) | **no** | **no** |
| Auth (Cognito) and web (CloudFront) in the new account | yes | **no** | **no** |
| Per-environment secrets (Google OAuth, OpenAI key, model-gateway signing key, invoke key) | yes | **no** | **no** |
| ControlPlane stack (TypeScript) | yes | **no** | **no** |
| GitHub `AWS_DEPLOY_ROLE_ARN` points at | new account | legacy (inferred) | legacy (inferred) |
| GitHub environment protection (reviewers, branch policy) | none | branch policy `main` only, no reviewers | branch policy `main` only, no reviewers |

Blockers named on the board: hostname ownership (CloudFront alternate domain names
and Cognito custom domains are globally unique, and legacy still holds
`staging.chattic.us` and `hey.chattic.us`, so legacy must release them first),
Google OAuth secrets, per-environment ECR image with a real tag instead of the
hand-pushed `:dev`, the owner-computer path's development-only gate, and the
integration-test-principal decision for staging (chatticus-80b17c). Live staging
and production are now the TypeScript stacks in the production AWS account: both
are deployed, and production CloudFront is enabled (README "Deployed across
environments"). The legacy account's Python stacks no longer serve them.

Repo settings found with `gh api` (read-only): `main` has **no branch protection**
(HTTP 404) and no rulesets, and the `staging` and `production` GitHub environments have no required
reviewers and only a deployment branch policy limiting deploys to `main`. This is
the owner's decision (2026-10-15), not a gap.

## 6. What changes for users

- **Product users:** `hey.chattic.us` and `staging.chattic.us` web CloudFront are
  enabled and serve 200; the thin-turn API requires a Cognito
  token and returns 403 without one. I found no evidence of production end users.
  Treat the legacy staging and production Messaging tables as possibly holding
  household or test conversations until an owner-run count says otherwise (decision D5).
- **Marketing site users (real):** `chattic.us` is served by the private
  `Chattic.us-web` repo. Its `/api*` CloudFront behavior proxies to the **legacy
  production thin-turn Lambda Function URL**, read from SSM `/chatticus/production/thin-turn/*`,
  and serves `POST /api/waitlist/survey`, `/api/waitlist/confirm`, `/api/waitlist/invite`
  and `/api/contact` (`lib/waitlist-api.ts`, tests assert those paths). The TypeScript
  control plane does not implement waitlist or contact (TYPESCRIPT_CONTROL_PLANE.md
  sections 0 and 9 item 8: "Waitlist items stay untouched in Messaging for the
  private repo"). The moment legacy production thin-turn is replaced or removed,
  signups and contact submissions fail. This is the one genuinely user-visible risk
  and it gates the production cutover (not the merge to main itself, provided no
  workflow touches legacy production thin-turn, see section 8 step 3).
- **Data:** the TypeScript plane reads `Conversations` and the `PiSessions` bucket,
  not the Python `msg#` items. Staging and production need
  `conversation/bin/migrate-transcripts.ts` (copy, latest-turns, gate close, delta,
  verify, gate open), already built, idempotent, additive, with a 14-day rollback and
  a later `purge-legacy-items.ts`. Cognito users cannot be exported with passwords, so
  a new account means a new pool and re-linking by Google email. Snapshots stay in S3.
  No compat fork: after the flip there is one reader.

## 7. Website dependency

`Chattic.us-web/package.json` has `"chatticus": "https://github.com/AnthusAI/Chatticus/archive/refs/heads/main.tar.gz"`
with `transpilePackages: ["chatticus"]`, unpinned.

Imports used by the website (counted in its `app`, `components`, `lib`, `scripts`):
`chatticus/lib/ogImage`, `components/ui/{badge,button,card,input,avatar,accordion}`,
`lib/utils`, `components/workspace/{WorkspacePanel,types}`, `tailwind-preset`,
`styles/shared.css`. I checked every path in the root `exports` map against develop:
all exist. Between main and develop the only changes under those paths are four new
workspace components and `ui/sheet.tsx` (additions); the shared files are unchanged,
and the `exports` map in `package.json` is identical (develop only adds workspaces
and devDependencies, which are not installed for a tarball dependency). The **UI kit
contract is compatible.**

What breaks: the website's `scripts/generate-wiki.sh` (its `prebuild`) runs
`python3 -m chatticus.wiki_publish` from `node_modules/chatticus/python/src`, its CI
and `deploy-marketing-production.yml` run `pip install -e "node_modules/chatticus/python[wiki]"`,
and its Gherkin runs `behave` from the Python tree. `python/` is deleted on develop,
so `pip install` fails and wiki generation falls back to a possibly absent
`generated/wiki/pages.json` (the script exits 1 if it is missing). A merge to main
therefore breaks the website's next build and deploy. Note the same marketing deploy
workflow's SSM lookup to the legacy production thin-turn is separate (section 6).

## 8. Open PRs, branches, CI

- CI on develop: the last six runs (03:59 to 07:16 UTC on 2026-10-13, head b902f5d3)
  all succeeded. Jobs: infra (tests, template artifact check, synth), web (tests,
  lint, typecheck, build), conversation (typecheck, vitest, cucumber, dry run).
- Open PRs (all into develop): #394 docs-only session namespace design, CLEAN,
  mergeable, can land or wait. #347 README-only "development workspace deployment",
  DIRTY (conflicts), stale since Sep 10; close or rebase. #348 draft "select
  interchangeable LLM vendors per turn", 49 files, DIRTY, stale since Sep 11, and
  conflicts with the reorganized `conversation/`; close and re-file against current
  develop if still wanted (note AGENTS.md: v1's LLM is OpenAI). None blocks the
  promotion; none should be merged during it.
- Stale branches: `ts/owner-supervisor`, `-container`, `-infra`, `-server` (1 to 3
  unmerged commits each), `claude/session-namespace-design` (PR 394),
  `codex/real-workspace-live-readme`, `cursor/turn-model-selection`. Prune after the
  promotion; verify each is merged or abandoned first.
- Open Kanbus items that touch the promotion: TS-69 (chatticus-52d238, remove the
  own-account host task and service, "before staging and production promotion"),
  chatticus-d6997c (promote control plane and owner path), chatticus-7ebd57 (repeat
  the account move), chatticus-80b17c. Record the decisions below on the board on
  `develop`, no PR.

## 9. Recommended plan

Principle: separate three things the current setup fuses: (a) making `main` carry
the TypeScript code, (b) cutting a release, (c) deploying staging and production.
The merge (a) should be boring and safe; (c) is a deliberate, human-gated project,
as chatticus-89a222 already states ("Production is a separate deploy of a
staging-proven release, not a promotion that happens because main moved").

Nothing below runs without the owner's yes. Steps 1 to 6 are reversible and touch
no AWS resource.

1. **No branch protection, no environment reviewers (decision, owner, 2026-10-15).**
   The owner chose friction-free: `main` has no branch protection and the `staging`
   and `production` environments have no required reviewers. The environments keep
   a deployment branch policy that allows `main` only. This step is closed; do not
   add protection or reviewers.
2. **Neutralize push-to-main deploys in a PR into `develop`** (product PR with
   sub-agent review, then merge): change the staging and production deploy
   workflows (`deploy-web-*`, `deploy-thinturn-*`, `deploy-controlplane-*`) from
   `on: push: branches: [main]` to `workflow_dispatch` only, and make
   `deploy-auth-*` dispatch-only too. Also reconcile the account model: web, auth and
   thin-turn staging and production should all go through
   `deploy-chatticus-dedicated-account.sh`, or the legacy scripts should be removed,
   so a workflow can never mix them; remove the duplicated overlapping deploys
   (thinturn, web, controlplane all redeploy control-plane). Cost: staging stops
   auto-deploying on merge until re-enabled; one dispatch click replaces it. When
   staging is bootstrapped and stable, re-enable `push` for staging only (production
   stays dispatch-only).
3. **Make semantic-release safe.** Tag main's current head e68b5f4f as `v0.43.1`
   (baseline; a plain tag push to a new name, owner action, not a main push). Verify
   with `npx semantic-release --dry-run --no-ci` on a scratch checkout of the merged
   result that it proposes 0.44.0. Optionally raise the guard so it checks before
   publishing (move the 0.* check ahead of the tag push, for example via a
   `--dry-run` job whose output gates the real run). Cost: one extra tag; one small
   workflow change.
4. **Decouple the marketing site (private repo, separate PR there).** Before the
   merge, pin its dependency to the exact Python-era tarball
   (`.../archive/e68b5f4f....tar.gz`) so its builds are unchanged, then port or
   vendor `wiki_publish` (the `anthus-markus` wiki publisher) into the website repo
   and drop `pip install -e node_modules/chatticus/python[wiki]` and the behave
   step; then return the dependency to `main`. Cost: the website stops tracking main
   until the vendoring lands; the UI kit is unchanged so no feature is lost. Pick the
   pin or an equivalent on the owner's word (decision D3).
5. **Decide the marketing intake backend (gates production cutover, not the merge).**
   The waitlist and contact endpoints must exist somewhere other than legacy
   production thin-turn before that stack is replaced. Options: a small Lambda in the
   website repo that reads and writes the existing `WAITLIST` and `CONTACT` items in
   the `Messaging` table, or keep legacy production thin-turn alive only for those
   routes (this violates "no dual paths" if it lingers, so only as a bounded bridge).
6. **Land or close the stragglers:** merge #394 (docs), close #347 and #348 with a
   comment, finish or defer TS-69. Run `kbs` housekeeping on `develop` (no PR).
7. **The merge PR.** Open `develop` into `main`, titled "Promote develop to main:
   TypeScript control plane" (conventional subject, no breaking marker), with the
   sub-agent review addressed and required checks green. Body: the section 2 table,
   the release expectation (v0.44.0), and a statement that no staging or production
   deploy runs. Merge with a **merge commit** (main's history so far is merge
   commits and the `v0.43.1` baseline must stay an ancestor); do not squash 691
   commits. Expected effects, to verify within minutes: CI green; semantic-release
   creates v0.44.0 and a changelog commit; no deploy workflow starts.
8. **Bootstrap staging, human-run, one stack at a time, never `--all`**, using the
   allowed per-stack script with the production account's SSO session (staging and production share it; section 11)
   (`sh infra/deploy-chatticus-dedicated-account.sh staging STACK`): the suffixed staging
   `snapshots`, `computers`, `thin-turn` first (the account's budget is production's, already there); `zones`; delegate from the management
   zone and verify with `dig` (this needs legacy to release `staging.chattic.us`
   first); `certificates`; seed the Google OAuth secret and the OpenAI parameter by
   hand; `control-plane`; `auth`; `web`. Repoint the staging environment's
   `AWS_DEPLOY_ROLE_ARN` to the dedicated account only now (verify with
   `verify-account-deploy-role.yml`). Run the migration runbook against staging
   (`migrate-transcripts.ts copy --dry-run`, `copy`, `latest-turns`, `gate close`,
   `delta`, `verify`, `gate open`), then `conversation/bin/acceptance.ts
   --environment staging` and a signed-in smoke turn. Cost: this is the real work; it
   is blocked on hostname release, Google secrets and the OpenAI key.
9. **Production, only after staging is proven, as a separate decision.** Same stack
   order, then migration, then DNS and CloudFront cutover with the marketing intake
   decision (D4) already implemented. Deploy by manual dispatch. Run acceptance, keep the legacy Python stacks and the old
   Messaging items untouched for the 14-day window, then the purge.

### Rollback

- Step 1 to 2: revert the settings or workflow PR.
- Step 3: delete the baseline tag (nothing depends on it before the merge).
- Step 7 (merge): `main` is a release branch with no deploy attached after step 2,
  so reverting the merge commit restores the tree. If semantic-release already
  tagged v0.44.0, delete the GitHub release and tag by hand.
- Steps 8 and 9: the migration is additive (old items untouched), the gate
  (`MIGRATING`) can be closed again, CloudFront can be pointed back at the legacy
  origin; the 14-day retention is the rollback window. After the purge there is no
  rollback, so do not run the purge early.

### Risks

- The release trap (section 3) if step 3 is skipped.
- Settings drift: someone re-enables `push` triggers before staging is real.
- Auth workflows redeploying legacy Cognito from new code if left on push (step 2).
- Cognito users do not carry over to a new pool; Google re-link by email only.
- Marketing intake breakage when legacy production thin-turn goes away.
- The README claim "Staging and production run Python" must be updated at the
  merge, and again at each cutover.
- The staging integration-principal question (chatticus-80b17c) is unresolved.

## 10. Decisions the owner must make

- **D1. Approve the sequence in section 9, or choose the alternative** of a staging-only
  branch (`staging`) that the staging workflows trigger on. The alternative avoids
  editing workflow triggers but adds a branch to keep in sync and still leaves
  production on main pushes. Recommendation: dispatch-only.
- **D2. Branch protection and environment reviewers.** Decided by the owner
  (2026-10-15): none. Friction-free, no protection.
- **D3. Website handling:** pin the website to the Python-era tarball until
  `wiki_publish` is vendored, or accept a short website build break, or keep a frozen
  copy of `wiki_publish` published from somewhere else.
- **D4. Marketing waitlist and contact backend:** which option in step 5, and who
  builds it, before production cutover.
- **D5. Is there real data in legacy staging or production Messaging?** Authorize a
  read-only item count (no scan of contents) to decide whether the transcript
  migration is needed at all or whether those environments can simply start fresh
  like development did.
- **D6. Release number:** accept v0.44.0 via a baseline tag, or deliberately start
  v1.0.0 (then also drop the `guard-pre-1-0` job and the `0.*` assumption in the
  docs).
- **D7. Hostnames:** confirm legacy releases `staging.chattic.us` and
  `hey.chattic.us` (and the apex-alias ordering with the website) so staging and
  production can be bootstrapped in the production account (staging and production share it; section 11).
- **D8. Staging parity:** should staging enable the integration-test principal
  (chatticus-80b17c), and does the owner-computer (Pi) path ship to staging and
  production in this promotion or stay development-only (chatticus-d6997c)?
- **D9. Stale PRs and branches:** close #347 and #348, merge or keep #394, prune the
  `ts/owner-supervisor*` branches.

## 11. Account topology: staging and production share one AWS account

Decision by the project owner (supersedes the "account per environment" wording above): there is no separate staging
AWS account. Development has an account of its own. Staging and production are separate environments in one account,
the production account, in `us-east-1`. No account ids appear here; take them from `AGENTS.local.md`.

The production account is already live: it holds the stacks below under the names they were deployed with, and serves
`hey.chattic.us` and `auth.chattic.us` from them. Staging is the environment being added to that account.

### Isolation by name: production keeps its live names, staging is suffixed

Production keeps every stack id, logical id and resource name it already has. Renaming a live stack would replace its
resources (a snapshot bucket, ECR repository, delegated Route 53 zones whose name servers the management zone delegates
to, ACM certificates) and change what the management account points at, so nothing in production is renamed. Staging, the
newcomer, takes the suffixed ids, so the two never collide on a CloudFormation stack, an ECR repository, an ECS task
definition family, an IAM role or a Cognito pool. Development keeps the unsuffixed ids it has always had, in its own
account. Tests compare the development templates and the production templates of the changed stacks to committed copies
(`infra/test/fixtures/development-templates`, `infra/test/fixtures/production-templates`).

| Kind | Development | Staging | Production (live) |
| --- | --- | --- | --- |
| Snapshots | `ChatticusSnapshots` | `ChatticusSnapshotsStaging` | `ChatticusSnapshots` |
| Computers (ECR, ECS, task definition family) | `ChatticusComputers` (`ChatticusComputerOwner`) | `ChatticusComputersStaging` (`ChatticusComputerOwnerStaging`) | `ChatticusComputers` (`ChatticusComputerOwner`) |
| Delegated zones | `ChatticusEnvironmentZones` | `ChatticusEnvironmentZonesStaging` | `ChatticusEnvironmentZones` |
| Certificates | `ChatticusEnvironmentCertificates` | `ChatticusEnvironmentCertificatesStaging` | `ChatticusEnvironmentCertificates` |
| Thin-turn, control-plane, web, auth | unsuffixed | `...Staging` | `...Production` |
| Deploy role stack | `ChatticusAccountDeploy` | `ChatticusAccountDeployStaging` | `ChatticusAccountDeploy` |
| Deploy role name | `chatticus-github-actions-deploy` | `chatticus-github-actions-deploy-staging` | `chatticus-github-actions-deploy` |
| GitHub OIDC provider | created by its deploy stack | imported by ARN from production's | created by `ChatticusAccountDeploy` |
| Owner task image tag | `dev` | `staging` | `production` |

The unsuffixed names in the production column coincide with development's only because the two live in different
accounts. The production owner task definition and its image tag do not exist in the account yet (the deployed Computers
stack predates them), so naming its tag `production` replaces nothing that runs.

Account-level, one copy in the production account: `ChatticusBudgets` (its monthly limit is the combined limit of staging
and production; per-environment spend comes from the `chatticus:environment` tag). It already exists, is tagged
`production`, and only development and production deploy it; the staging deploy script refuses it, and the staging
thin-turn and auth stacks read the alerts topic from the production copy. The single GitHub OIDC provider is owned by
production's `ChatticusAccountDeploy`, which has always created it; staging's deploy stack imports it. Deleting
`ChatticusAccountDeploy` would delete the provider and lock staging out. CDK bootstrap (`CDKToolkit`) already exists in
the account.

### Adding staging to the live production account

Production is not bootstrapped again: its stacks exist, and the work below only touches production for one in-place
change (step 1). Each step is one stack, run by a person with the production account's SSO session, never `--all`.

1. `sh infra/deploy-chatticus-account-deploy.sh production`: an in-place update of the existing deploy stack that
   attaches one IAM policy to the existing deploy role, denying it the staging stacks, staging SSM paths and
   `staging`-tagged resources. Run `cdk diff ChatticusAccountDeploy -c githubDeployEnvironment=production` first; the
   only change is that policy.
2. `sh infra/deploy-chatticus-account-deploy.sh staging`: the new staging deploy role (`chatticus-github-actions-deploy-staging`),
   which needs production's stack to exist because it imports the OIDC provider that stack created. Set the staging
   GitHub environment's `AWS_NEW_ACCOUNT_DEPLOY_ROLE_ARN` and dispatch `verify-account-deploy-role.yml`.
3. For staging only, each with `sh infra/deploy-chatticus-dedicated-account.sh staging STACK` in this order:
   `snapshots`, `computers`, `zones`, (delegate both names from the management zone, wait for `dig`), `certificates`,
   `thin-turn`, (a person seeds the Google OAuth secret and the OpenAI parameter), `control-plane`, `auth`, `web`.
   There is no `staging budgets` step: the account's budget is production's.

### Production's live stacks are behind the code

`cdk diff` of the production stacks against the account (template comparison, read-only) shows no replacement and no
deletion caused by the naming, and the same differences before and after the staging work: code asset hashes for the
Lambda functions and website, the invoke-key origin header, a snapshot bucket lifecycle rule. The deployed
`ChatticusComputers` is older than the code: deploying it removes the old `ComputerTask` and `FargateHost` service
(desired count 0, no image in the repository) and adds the owner task definition, and deploying `ChatticusSnapshots`
removes an export that the deployed `ChatticusComputers` still imports. Deploy `ChatticusComputers` before
`ChatticusSnapshots`, and read both diffs first.

### What the shared account does not isolate

- The two deploy roles are `AdministratorAccess` with explicit denies on the other environment's stacks, SSM parameter
  paths and `chatticus:environment`-tagged resources. CDK deploys go through the one set of bootstrap roles
  (`cdk-*-deploy-role`, `cdk-*-cfn-exec-role`), which both environments share, so a deploy role that is compromised can still
  reach the other environment through them. Closing that needs a separate bootstrap qualifier per environment. This is
  decision D10 below.
- ECS, VPC and CloudFront account quotas are shared; the two computers stacks each create a VPC.

### Not built here (follow-ups)

- A promote workflow for staging and production computer images, the staging/production counterpart of
  `promote-computer-image-development.yml`. Until it exists the staging and production repositories hold no image.
- The control-plane owner wiring (`computerOwnerStartConfig`) is still development-only (decision D8).

### Decision D10

Accept the shared bootstrap roles (above), or bootstrap the production account twice with distinct qualifiers and give each
environment's stacks its own synthesizer.
