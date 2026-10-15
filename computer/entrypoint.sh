#!/bin/sh
set -eu

LIVE="${CHATTICUS_LIVE_ROOT:-/var/lib/chatticus/computer}"
mkdir -p "${LIVE}/workspace"

if [ -d "${LIVE}/browser-profile" ] && [ ! -d "${LIVE}/browser-profiles" ]; then
  mkdir -p "${LIVE}/browser-profiles/privileged"
  mv "${LIVE}/browser-profile" "${LIVE}/browser-profiles/privileged/_legacy"
fi
mkdir -p "${LIVE}/browser-profiles/untrusted" "${LIVE}/browser-profiles/privileged"

if [ -L /workspace ]; then
  ln -sfn "${LIVE}/workspace" /workspace
elif [ -d /workspace ]; then
  rmdir /workspace 2>/dev/null || true
  if [ -d /workspace ] && [ ! -L /workspace ]; then
    echo "chatticus: /workspace exists and is not empty; using it as the live workspace" >&2
  else
    ln -sfn "${LIVE}/workspace" /workspace
  fi
else
  ln -sfn "${LIVE}/workspace" /workspace
fi

cd /workspace

if [ -n "${CHATTICUS_SMOKE_COMPUTER:-}" ]; then
  printf '%s\n' "from-aws-fargate" > "${LIVE}/workspace/aws-fargate.md"
  node /opt/chatticus/host/snapshot.mjs pack \
    --live-root "${LIVE}" \
    --store s3 \
    --tenant "${CHATTICUS_TENANT_ID:-anthus}" \
    --computer "${CHATTICUS_SMOKE_COMPUTER}" \
    --worker fargate-aws
fi

exec "$@"
