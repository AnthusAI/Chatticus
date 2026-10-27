# Mail infrastructure (external channels, milestone 1)

This is the AWS side of email for external channels (see `docs/EXTERNAL_CHANNELS.md`). It is CDK only, in `infra/lib/mail-ingress-stack.ts` and
`infra/lib/mail-stack.ts`. The three mail Lambdas (ingress, delivery, status) are M1.8 and live in the per-environment mail stack; the wiring of the channels
runtime into the deployed front door is M1.7a.

## Shape

- `ChatticusMailIngress` (shared, one per account and region): the account's single SES receipt rule set, named `chatticus-mail-ingress`, and a
  custom resource that activates it. The same custom resource deactivates the set on delete, because an active rule set cannot be deleted. The
  stack has termination protection and holds no receipt rule. Environment mail stacks import the rule set name, so CloudFormation refuses to
  delete it while a rule is still in the set.
- `ChatticusMailDevelopment` (per environment): a retained public hosted zone for the mail domain, an SES domain identity with Easy DKIM and a
  custom MAIL FROM subdomain (`bounce.` below the mail domain), a DMARC record at `p=none` for the mail subdomain only, MX records for the bare
  mail name and a wildcard below it pointing at the SES inbound endpoint, one private raw mail bucket, one receipt rule for this environment's
  domain with two actions in order (the S3 action under `raw/` first, then an asynchronous Lambda action that invokes the ingress function),
  and the outbound configuration set `chatticus-development-outbound` whose send, bounce, complaint, delivery and reject events go to one
  SNS topic that signs with signature version 2.
- The three functions, each with its own role, its own dead-letter queue (failed asynchronous invocations run again twice, then land there with the
  error), an errors alarm and a dead-letter alarm to the environment's alarm topic: `MailIngress` (receipt rule action; reads `raw/*`, admits the message),
  `MailDelivery` (target of the default-bus rule for `chatticus.channels` / `channel.message.created`; `ses:SendEmail` on the domain identity and
  the configuration set only) and `MailStatus` (subscribed to the topic; verifies the SNS signature, certificate host and topic ARN, then records
  the status). The raw archive stays the system of record: a message that landed in a dead-letter queue is replayed from `raw/<ses message id>`.
- Raw mail is kept 30 days, then expired by a lifecycle rule. The bucket is private, encrypted with S3 managed keys, TLS only, and retained on
  stack delete. SES may put objects under `raw/` only for this account and this one receipt rule.
- The existing `chattic.us` SES identity is owned by the marketing site (private `Chattic.us-web`, which sends waitlist mail from it). Nothing
  here reads, edits or depends on it. The mail subdomain has its own identity, its own DMARC record and its own configuration set. The account
  level suppression list and the sandbox limits (200 messages a day, 1 a second) are shared and unchanged.

## Rollout switch

`MAIL_ENVIRONMENTS` in `infra/lib/environments.ts` is `["development"]`. Staging and production cannot grow a mail stack until that list, the
deploy script mapping and a deploy workflow are changed together. Domains are in `MAIL_DOMAINS`: `mail.develop.chattic.us`,
`mail.staging.chattic.us` and `mail.chattic.us`.

Development (and later staging) delegate the mail zone with one NS record in that environment's own site zone, in the same account, so no
management account change is needed. Production mail uses `mail.chattic.us`, which needs one NS record in the management account's
`chattic.us` zone pointing at the name servers in the stack output `MailZoneNameServers`. The owner adds that record later, by hand or
through the management DNS stack. It is not built or performed by any task in M1.

## Deploy

The mail stack imports the stores, queues and alarm topic of the same environment's control plane, the Messaging table of thin-turn and the
site zone, as CloudFormation exports. Merging to develop starts the control plane workflow and the mail workflow together, so the mail
workflow's first step, `infra/wait-for-control-plane-exports.sh`, waits (every 30 seconds, at most 40 minutes) until every stack the mail template
imports from is in `CREATE_COMPLETE` or `UPDATE_COMPLETE` and exposes the export names the mail template needs, read from the synthesized template so
the list cannot drift. It needs no secret and no permission beyond `cloudformation:DescribeStacks`, since an export is an output of its stack. On
timeout it fails with the stacks that were not ready. Adding the Lambda action to the live rule is safe: the function and the permission that lets
the rule invoke it are created before the rule is updated, the S3 action stays first, and a failed update leaves the old rule in place.

**Export-lock hazard.** CloudFormation refuses to change or remove an exported value while another stack imports it. A control plane change that
alters an exported value (replacing the conversations table, the PiSessions bucket, a queue or the alarm topic) fails until the mail stack is
deployed without the import first. Treat those resources as fixed while mail imports them, or deploy mail without the import before the change.

**Staging and production.** Before mail is enabled there, the mail stack must stop importing from the application stacks: pass the stores, queues
and topic by SSM parameters or by deterministic names that the application stacks publish, so the stacks deploy in any order and no export lock
exists. Do not extend `MAIL_ENVIRONMENTS` until that is done.

`.github/workflows/deploy-mail-development.yml` runs on push to `develop`, with OIDC role assumption and no new secrets. It deploys
`ChatticusMailIngress` first and `ChatticusMailDevelopment` second, each by name through
`infra/deploy-chatticus-dedicated-account.sh development mail-ingress` and `... development mail`. Never `cdk deploy --all`. There is no
staging or production workflow or script mapping.

The deploy role gets no new permission. SES, Route 53, S3 and SNS calls run under the CDK bootstrap roles. The role only gains read access to
the two new stacks (status for the deploy script's wait loop), through the existing stack read statement.

## Owner actions that are not in CDK

- Verify tester address identities by command line (`aws sesv2 create-email-identity`), never in the repository. Each address then receives a
  verification message that its owner must accept.
- Production only, later: the NS record for `mail.chattic.us` in the management account's zone.

## Read-only verification (profile of the environment account, us-east-1; prints no account ids)

```
aws ses describe-active-receipt-rule-set --query 'Metadata.Name'
aws ses describe-receipt-rule-set --rule-set-name chatticus-mail-ingress --query 'Rules[].[Name,Enabled,Recipients]'
aws sesv2 get-email-identity --email-identity mail.develop.chattic.us --query '[VerifiedForSendingStatus,DkimAttributes.Status,MailFromAttributes.MailFromDomainStatus]'
aws sesv2 get-configuration-set --configuration-set-name chatticus-development-outbound --query '[Name,ReputationOptions]'
aws sesv2 get-configuration-set-event-destinations --configuration-set-name chatticus-development-outbound --query 'EventDestinations[].[Name,Enabled,MatchingEventTypes]'
aws sesv2 get-account --query '[ProductionAccessEnabled,SendQuota]'
aws cloudformation describe-stacks --stack-name ChatticusMailIngress --query 'Stacks[0].StackStatus'
aws cloudformation describe-stacks --stack-name ChatticusMailDevelopment --query 'Stacks[0].[StackStatus,Outputs[].[OutputKey,OutputValue]]'
dig +short NS mail.develop.chattic.us
dig +short MX mail.develop.chattic.us
dig +short MX anything.mail.develop.chattic.us
```

## Rollback

Delete `ChatticusMailDevelopment` (termination protection must be turned off first): the identity, the records, the rule and the topic go with
it, and the zone and the raw mail bucket are retained, so the owner empties and deletes them by hand. The shared stack is deleted last and only
after no environment rule remains: its custom resource deactivates the rule set first. Mail to the domain bounces while the rule or the MX is
absent.

## Cost at sandbox volume

About 1.3 USD a month for development, mostly the mail hosted zone (0.50) and, once the Lambdas land, alarms. No Amazon request is made.
