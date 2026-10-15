#!/bin/bash
set -euo pipefail

if [ ! -f /exports/.nfs-backend ]; then
    exit 1
fi

backend="$(cat /exports/.nfs-backend)"
case "$backend" in
    kernel)
        showmount -e localhost 2>/dev/null | grep -q /exports
        ;;
    ganesha)
        ss -ltn 2>/dev/null | grep -q ':2049'
        ;;
    *)
        exit 1
        ;;
esac
