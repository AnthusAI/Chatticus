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
exec "$@"
