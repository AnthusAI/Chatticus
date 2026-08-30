# Computer snapshots

A Chatticus **computer** is a workplace identity (`computer_id`), not a
particular Mac, Fargate task, or EC2 instance. Any machine that can run the
computer image is a **host**. A garage Mac is a host in the same sense Fargate
is a host. It is cheaper when it is on. It is not a different kind of
computer.

Hosts do not share a running container. Live migration is out of scope. The
durable workplace is a **snapshot in S3**. A host that should run the
computer **hydrates** that snapshot onto local disk, runs, then **publishes**
again before someone else takes over.

## What is stored where

The Ubuntu image (Xvfb, Chromium, worker, agent) lives in a **registry**
(ECR). Every host already pulls that image. Do not copy OS layers from a Mac
to AWS or back.

The snapshot is only the **durable workplace**:

| Object | In the snapshot | Not in the snapshot |
| --- | --- | --- |
| `/workspace` | yes | |
| Chromium profile (cookies, logins) | yes | |
| Image layers / apt packages | | registry image; treat extra packages as replaceable |
| Bot memory, chats, skills | | DynamoDB |
| Secrets | | Secrets Manager |

Canonical layout:

```
s3://chatticus-{env}/tenants/{tenant_id}/computers/{computer_id}/
  snapshot.tar.gz       workspace + browser profile
  manifest.json         image digest, checksum, published_by, published_at
```

`manifest.json` names the image digest the snapshot was taken against. A
host whose local image does not match still hydrates the workplace files; it
does not docker-load a private OS.

## Why not "just leave it in S3 and mount it"

S3 is the object every host can **see**. It is a bad live disk for Chromium
and overlayfs: high latency, no POSIX semantics that a browser profile
needs, and concurrent writers from two hosts would split the brain.

Each running host has a **local cache** (Docker volume, bind-mount, or EBS).
S3 is the last published checkpoint. Using a computer without copying bytes
onto that host is not a goal. Seeing the same checkpoint without
administrator-to-administrator copies **is**.

EFS can back `/workspace` on AWS hosts that share a VPC. It does not attach
to a home Mac. The Mac still hydrates from S3. Do not design two durable
stores. S3 is canonical. EFS, if used, is an AWS-side cache of the same
files.

## Publish, hydrate, relocate

No magic mover. Three administrator-or-worker operations:

1. **Publish.** The host that currently has the live disk stops writes, packs
   `/workspace` and the browser profile, uploads to the computer's snapshot
   URI, and records the checksum. The computer is no longer dirty.
2. **Relocate.** An administrator names the next host. The control plane
   does not copy a container. It records `intended_host_worker_id` and
   `hydrate_required`. Turns for that computer go only to that host until it
   hydrates. Other hosts of the same `computer_id` do not run it in the
   meantime (no split brain).
3. **Hydrate.** That host downloads the snapshot (or hits a local cache with
   the same checksum), unpacks onto its volume, and clears
   `hydrate_required`. Prefer-local ranking resumes.

Copying "a bunch of containers from AWS to my Mac" is this sequence aimed
at the Mac: publish on AWS if needed, relocate to the Mac worker, the Mac
hydrates. The other direction is the same with Fargate or EC2 as the target.

Failover when a prefer-local Mac's heartbeat dies is the same hydrate path on
an AWS host, without an administrator picking the target. That is not live
migration. It is "start from the last snapshot." Work that was never
published is gone, same as an unsynced volume.

## Dirty disk

Writes on a host mark the computer **dirty**. Relocate is rejected until the
current host publishes. That is the administrator safety: do not point the
Mac at S3 and throw away the Fargate volume's last hour of cookies.

An explicit discard (not v1 kernel) is the only way to relocate without
publishing.

## What we will not build

- Live container move (CRIU, `docker checkpoint`, rsync of overlay2 while
  Chromium is running)
- `docker save` / `docker load` of the whole image as the relocation story
- Mounting the snapshot bucket as the container root
- Two hosts running the same `computer_id` with two live disks

The control-plane kernel records snapshot URI, checksum, dirty, intended
host, and hydrate-required. Hosts pack `/workspace` and the browser profile
into `snapshot.tar.gz` plus `manifest.json`.

A **filesystem object store** is the local stand-in. Production uses the S3
bucket created by the CDK stack `ChatticusSnapshots`. Hosts set
`CHATTICUS_SNAPSHOT_BUCKET` to the stack output and pack with `--store s3`.
Do not create that bucket with the AWS CLI.

```bash
cd infra
npm install
npx cdk bootstrap
npx cdk deploy --all
export CHATTICUS_SNAPSHOT_BUCKET=<SnapshotBucketName>

python -m chatticus.snapshot pack \
  --live-root ./var/hosts/fargate \
  --store s3 \
  --tenant anthus \
  --computer household-computer \
  --worker fargate-1

python -m chatticus.snapshot hydrate \
  --live-root ./var/hosts/garage-mac \
  --store s3 \
  --tenant anthus \
  --computer household-computer
```

If the Mac already has a cache whose checksum matches the manifest, hydrate
does not download the pack again.

Inside the computer image, `/workspace` is a symlink to
`/var/lib/chatticus/computer/workspace`. Do not give two hosts the same live
volume. They share the snapshot store only.

Prove relocate with two running containers:

```bash
sh computer/test_relocate.sh
```


