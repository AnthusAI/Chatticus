#!/bin/bash
set -euo pipefail

EXPORT_ROOT="${EXPORT_ROOT:-/exports/workspace}"
if [ ! -d "${EXPORT_ROOT}/chatticus/.git" ]; then
    echo "ERROR: export workspace missing at ${EXPORT_ROOT}/chatticus"
    exit 1
fi
mkdir -p /local-workspace
if ! mountpoint -q /local-workspace; then
    mount --bind "${EXPORT_ROOT}" /local-workspace
fi
echo "Local control: bind mount ${EXPORT_ROOT} -> /local-workspace (no NFS, no netem)"
exec sleep infinity
