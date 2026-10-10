# Chatticus computer
#
# Long-lived Linux workplace. Same image on Fargate, EC2, and local Docker.
# Not a Lambda runtime. Build from the repository root:
#   docker build -f computer/Dockerfile -t chatticus-computer .

# The default image carries files, git and a shell: no display and no browser.
# The browser is an optional capability that a larger image adds back.
# The host worker and the snapshot program are esbuild bundles; the image
# carries Node alone.
FROM node:22-bookworm-slim AS host-bundle

WORKDIR /build
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
COPY infra/package.json infra/package.json
COPY conversation/package.json conversation/package.json
COPY host-protocol/package.json host-protocol/package.json
COPY computer/host/package.json computer/host/package.json
RUN npm ci --ignore-scripts --workspace=computer/host --workspace=conversation --workspace=host-protocol
COPY host-protocol host-protocol
COPY conversation conversation
COPY computer/host computer/host
RUN CHATTICUS_HOST_BUNDLE_DIR=/opt/chatticus/host npm run bundle --workspace=computer/host

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    CHATTICUS_LIVE_ROOT=/var/lib/chatticus/computer \
    CHATTICUS_SNAPSHOT_STORE=/var/lib/chatticus/store

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY --from=host-bundle /opt/chatticus/host /opt/chatticus/host

COPY computer/entrypoint.sh /usr/local/bin/chatticus-computer-entrypoint
COPY computer/chatticus-shell /usr/local/bin/chatticus-shell

# Commands the model chooses run as chatticus-shell, never as root. The workspace
# is shared with it through the chatticus-workspace group; everything else the
# image holds for the owner stays out of its reach.
RUN groupadd --gid 2000 chatticus-shell \
    && groupadd --gid 2001 chatticus-workspace \
    && useradd --uid 2000 --gid chatticus-shell --groups chatticus-workspace \
        --no-create-home --home-dir /workspace --shell /usr/sbin/nologin chatticus-shell \
    && chmod 755 /usr/local/bin/chatticus-computer-entrypoint /usr/local/bin/chatticus-shell \
    && mkdir -p /var/lib/chatticus/computer/workspace \
        /var/lib/chatticus/computer/browser-profiles/untrusted \
        /var/lib/chatticus/computer/browser-profiles/privileged \
        /var/lib/chatticus/store \
    && chgrp -R chatticus-workspace /var/lib/chatticus/computer/workspace \
    && chmod -R 2775 /var/lib/chatticus/computer/workspace \
    && chmod 700 /var/lib/chatticus/store

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/chatticus-computer-entrypoint"]
CMD ["sleep", "infinity"]
