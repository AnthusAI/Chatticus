#!/bin/sh
set -eu

LIVE="${CHATTICUS_LIVE_ROOT:-/var/lib/chatticus/computer}"
mkdir -p "${LIVE}/workspace" "${LIVE}/browser-profile"

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
  python -m chatticus.snapshot pack \
    --live-root "${LIVE}" \
    --store s3 \
    --tenant "${CHATTICUS_TENANT_ID:-anthus}" \
    --computer "${CHATTICUS_SMOKE_COMPUTER}" \
    --worker fargate-aws
fi

exec "$@"
