#!/bin/bash
set -euo pipefail

LOG=/var/log/nfs-start.log
BACKEND_FILE=/exports/.nfs-backend

mkdir -p /exports/workspace /var/run/ganesha
chmod 1777 /exports

stop_kernel_nfs() {
    exportfs -au 2>/dev/null || true
    rpc.nfsd 0 2>/dev/null || true
    killall -9 rpc.mountd 2>/dev/null || true
    killall -9 rpc.nfsd 2>/dev/null || true
    sleep 2
}

port_2049_free() {
    ! ss -ltn 2>/dev/null | grep -q ':2049'
}

try_kernel() {
    echo "Attempting nfs-kernel-server..." | tee -a "$LOG"
    rpcbind
    echo "/exports *(rw,sync,no_subtree_check,no_root_squash,fsid=0)" >/etc/exports
    if ! rpc.nfsd 2>>"$LOG"; then
        stop_kernel_nfs
        return 1
    fi
    exportfs -ra 2>>"$LOG" || {
        stop_kernel_nfs
        return 1
    }
    sleep 2
    if showmount -e localhost 2>/dev/null | grep -q /exports; then
        echo "kernel" >"$BACKEND_FILE"
        echo "Using nfs-kernel-server" | tee -a "$LOG"
        exec rpc.mountd -F
    fi
    stop_kernel_nfs
    return 1
}

start_ganesha() {
    stop_kernel_nfs
    for _ in 1 2 3 4 5; do
        port_2049_free && break
        stop_kernel_nfs
    done
    if ! port_2049_free; then
        echo "Port 2049 still in use; cannot start ganesha" | tee -a "$LOG"
        exit 2
    fi
    echo "Starting nfs-ganesha (userspace fallback)..." | tee -a "$LOG"
    echo "ganesha" >"$BACKEND_FILE"
    exec /usr/bin/ganesha.nfsd -F -L /var/log/ganesha.log -f /etc/ganesha/ganesha.conf
}

if try_kernel; then
    exit 0
fi

start_ganesha
