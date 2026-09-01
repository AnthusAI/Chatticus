#!/bin/sh
# Relocate a workplace between two running computer containers.
# Pack on Fargate, hydrate on the Mac, write more, pack, hydrate back.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

TENANT="${CHATTICUS_TENANT_ID:-anthus}"
COMPUTER="${CHATTICUS_COMPUTER_ID:-household-computer}"
STORE="/var/lib/chatticus/store"

echo "Building and starting two computer hosts..."
docker compose up -d --build computer-fargate computer-mac

echo "Writing files on the Fargate host..."
docker compose exec -T computer-fargate sh -c 'printf "%s\n" "from-fargate" > /workspace/notes.md'
docker compose exec -T computer-fargate sh -c 'mkdir -p /var/lib/chatticus/computer/browser-profiles/privileged/banking/Default && printf "%s\n" "signed-in" > /var/lib/chatticus/computer/browser-profiles/privileged/banking/Default/Cookies'

echo "Publishing snapshot from Fargate..."
docker compose exec -T computer-fargate python -m chatticus.snapshot pack \
  --live-root /var/lib/chatticus/computer \
  --store "${STORE}" \
  --tenant "${TENANT}" \
  --computer "${COMPUTER}" \
  --worker fargate-1

echo "Hydrating onto the Mac host..."
docker compose exec -T computer-mac python -m chatticus.snapshot hydrate \
  --live-root /var/lib/chatticus/computer \
  --store "${STORE}" \
  --tenant "${TENANT}" \
  --computer "${COMPUTER}"

MAC_NOTES="$(docker compose exec -T computer-mac cat /workspace/notes.md)"
MAC_COOKIES="$(docker compose exec -T computer-mac cat /var/lib/chatticus/computer/browser-profiles/privileged/banking/Default/Cookies)"
if [ "${MAC_NOTES}" != "from-fargate" ]; then
  echo "FAIL: Mac workspace is '${MAC_NOTES}', expected from-fargate" >&2
  exit 1
fi
if [ "${MAC_COOKIES}" != "signed-in" ]; then
  echo "FAIL: Mac browser profile is '${MAC_COOKIES}', expected signed-in" >&2
  exit 1
fi
echo "Mac has Fargate files."

echo "Writing a new file on the Mac and leaving a stale file on Fargate..."
docker compose exec -T computer-fargate sh -c 'printf "%s\n" "stale" > /workspace/stale.md'
docker compose exec -T computer-mac sh -c 'printf "%s\n" "from-mac" > /workspace/handoff.md'
docker compose exec -T computer-mac python -m chatticus.snapshot pack \
  --live-root /var/lib/chatticus/computer \
  --store "${STORE}" \
  --tenant "${TENANT}" \
  --computer "${COMPUTER}" \
  --worker garage-mac-1

echo "Hydrating back onto Fargate..."
docker compose exec -T computer-fargate python -m chatticus.snapshot hydrate \
  --live-root /var/lib/chatticus/computer \
  --store "${STORE}" \
  --tenant "${TENANT}" \
  --computer "${COMPUTER}"

FARGATE_HANDOFF="$(docker compose exec -T computer-fargate cat /workspace/handoff.md)"
if [ "${FARGATE_HANDOFF}" != "from-mac" ]; then
  echo "FAIL: Fargate missing Mac handoff file" >&2
  exit 1
fi
if docker compose exec -T computer-fargate test -e /workspace/stale.md; then
  echo "FAIL: stale.md survived hydrate on Fargate" >&2
  exit 1
fi
echo "Fargate has Mac files and dropped stale.md."

echo "OK: workplace relocated Fargate -> Mac -> Fargate"
