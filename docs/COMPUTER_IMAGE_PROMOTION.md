# Computer image promotion

Why this exists: on 2026-10-13 the first Phase 3 rollout pushed a new computer image to the moving `dev` tag before the
server side (the Front Door's S3 permission for the overlay) was proven in the real account. The in-memory and moto
stores enforce no IAM, so every test passed; in the account a missing snapshot object read as 403 AccessDenied, every
owner start failed its hydrate, and every computer start on development failed for about 40 minutes until the tag was
rolled back by hand in ECR. The rule that follows: **the image tag flips only after the server side of the same commit
is deployed and verified.**

## What runs today

The `ChatticusComputers` owner task definition runs the image `:dev` of the Computers ECR repository
(`infra/lib/computer-stack.ts`, `ecs.ContainerImage.fromEcrRepository(repository, "dev")`). That tag is what reaches every
computer start, so moving it is the production-relevant step of an image rollout. It is not part of the build.

| Step | Workflow | Tags it writes |
| --- | --- | --- |
| Build, check, push | `.github/workflows/build-computer-image-development.yml` (push to `develop`) | `sha-<commit>` only |
| Server side | `deploy-controlplane-development.yml`, `deploy-thinturn-development.yml` (push to `develop`) | none |
| Promote | `.github/workflows/promote-computer-image-development.yml` (`workflow_dispatch`, input `commit`) | `dev` |

The build never moves `dev`. `computer/push-computer-image.sh` (break-glass) pushes a `manual-<utc time>` tag and never
`dev` either.

## Per-environment tags

Each environment has its own Computers stack and therefore its own ECR repository, so a tag never crosses
environments. The owner task definition runs the moving tag `dev` in development (`ChatticusComputers`), `staging` in
staging (`ChatticusComputersStaging`) and `production` in production (`ChatticusComputersProduction`); staging and
production share one AWS account but not a repository. The tag name comes from `COMPUTER_IMAGE_TAGS` in
`infra/lib/environments.ts`. Only the development build and promote workflows exist today. A promote workflow for staging
and production (retag `sha-<commit>` after that environment's server side is verified, with the same rollback) is a
follow-up; until it exists those repositories have no image and nothing in staging or production starts an owner task.

## Promoting

1. Merge to `develop`. The build pushes `sha-<commit>`; the ControlPlane and ThinTurn deploys run for the same commit.
2. Prove the new server side against the real account: the offline guard already ran in CI
   (see `docs/ROLE_ACCESS_GUARD.md`); optionally run the read-only
   `npx tsx conversation/bin/simulate-role-access.ts --environment development` after the deploy.
3. Run the **Promote computer image (development)** workflow with the full commit sha. It runs
   `infra/promote-computer-image-development.sh`, which:
   - refuses unless the latest `deploy-controlplane-development.yml` and `deploy-thinturn-development.yml` runs for that
     commit (`gh run list --commit`) both concluded `success`;
   - refuses unless the repository has an image tagged `sha-<commit>`;
   - reads the digest `dev` points at now (the previous digest), moves `dev` to the `sha-<commit>` manifest with
     `aws ecr put-image`, checks that `dev` now has the digest of `sha-<commit>`, and prints the previous digest together
     with the rollback command (also in the job summary).

A break-glass image (`manual-<utc time>`, from `computer/push-computer-image.sh`) is promoted by hand after the same
verification, with the rollback commands below: read the manifest of the `manual-` tag (`--image-ids imageTag=manual-...`),
note the digest `dev` has now, and write the manifest under `--image-tag dev`.

## Rolling back

Put the previous digest back under `dev`. This is a read of the old manifest and a write of the tag; nothing is rebuilt:

```sh
REPO_NAME=<repository name, from the ChatticusComputers ComputerRepositoryUri output after the first slash>
PREVIOUS_DIGEST=<sha256:... printed by the promotion>
MANIFEST="$(aws ecr batch-get-image --region us-east-1 --repository-name "${REPO_NAME}" \
  --image-ids "imageDigest=${PREVIOUS_DIGEST}" --query 'images[0].imageManifest' --output text)"
aws ecr put-image --region us-east-1 --repository-name "${REPO_NAME}" --image-tag dev --image-manifest "${MANIFEST}"
```

Running computers keep the image they started with; a rollback changes what the next start uses. The previous digest
stays in the repository after `dev` moves (there is no lifecycle policy), so it can be restored at any time.
