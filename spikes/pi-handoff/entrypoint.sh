#!/bin/sh
set -u
entry="${SPIKE_ENTRY:-owner-raw}"
node "/app/${entry}.mjs" b
status=$?
echo "--- container evidence ---"
echo "whoami: $(id -un) (uid $(id -u))"
head -1 /etc/os-release
git --version
ls -l /workspace
cat /workspace/hello.txt /workspace/notes.md 2>/dev/null || true
exit "$status"
