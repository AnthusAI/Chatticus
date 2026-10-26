#!/bin/sh
# Wait until the development control plane stack is settled and exposes every export the development mail stack imports.
#
# The mail stack imports stores, queues and the alarm topic from ChatticusControlPlaneDevelopment, and the Messaging table, the site zone
# and the receipt rule set from their own stacks. Merging to develop starts the
# control plane workflow and the mail workflow together, so the mail deploy can run before those exports exist, and it then
# fails at the change set before anything changes. This script makes the mail workflow wait instead. It reads only
# cloudformation:DescribeStacks on the control plane stack (an export is an output of its stack), which the deploy role already
# holds, and it needs no secret. The names to wait for are read from the synthesized mail template, so the list cannot drift.
#
# Polls every WAIT_POLL_SECONDS (30) for at most WAIT_MAXIMUM_POLLS (80, forty minutes) and fails with a message on timeout.
set -eu

cd "$(dirname "$0")"

CONSUMER_STACK="ChatticusMailDevelopment"
WAIT_POLL_SECONDS="${WAIT_POLL_SECONDS:-30}"
WAIT_MAXIMUM_POLLS="${WAIT_MAXIMUM_POLLS:-80}"

WORK_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "${WORK_DIRECTORY}"' EXIT

npx cdk synth "${CONSUMER_STACK}" --exclusively --quiet --output "${WORK_DIRECTORY}/cdk.out" -c chatticusAccountEnvironment=development

jq -r '.. | objects | select(has("Fn::ImportValue")) | ."Fn::ImportValue" | strings' "${WORK_DIRECTORY}/cdk.out/${CONSUMER_STACK}.template.json" \
  | sort -u >"${WORK_DIRECTORY}/required.txt"

REQUIRED_COUNT="$(wc -l <"${WORK_DIRECTORY}/required.txt" | tr -d ' ')"
if [ "${REQUIRED_COUNT}" -eq 0 ]; then
  echo "The ${CONSUMER_STACK} template imports nothing; nothing to wait for."
  exit 0
fi
cut -d: -f1 "${WORK_DIRECTORY}/required.txt" | sort -u >"${WORK_DIRECTORY}/producers.txt"
echo "Waiting for $(wc -l <"${WORK_DIRECTORY}/producers.txt" | tr -d ' ') stack(s) to settle and export the ${REQUIRED_COUNT} name(s) that ${CONSUMER_STACK} imports."

POLLS=0
while :; do
  NOT_READY=""
  for PRODUCER_STACK in $(cat "${WORK_DIRECTORY}/producers.txt"); do
    STATUS="$(aws cloudformation describe-stacks --stack-name "${PRODUCER_STACK}" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo ABSENT)"
    aws cloudformation describe-stacks --stack-name "${PRODUCER_STACK}" --query 'Stacks[0].Outputs[].ExportName' --output text 2>/dev/null \
      | tr '\t' '\n' | sort -u >"${WORK_DIRECTORY}/exported.txt" || true
    grep "^${PRODUCER_STACK}:" "${WORK_DIRECTORY}/required.txt" >"${WORK_DIRECTORY}/needed.txt" || true
    MISSING="$(comm -23 "${WORK_DIRECTORY}/needed.txt" "${WORK_DIRECTORY}/exported.txt" | wc -l | tr -d ' ')"
    case "${STATUS}" in
      CREATE_COMPLETE | UPDATE_COMPLETE)
        if [ "${MISSING}" -ne 0 ]; then NOT_READY="${NOT_READY} ${PRODUCER_STACK}(${STATUS}, ${MISSING} export(s) missing)"; fi
        ;;
      *) NOT_READY="${NOT_READY} ${PRODUCER_STACK}(${STATUS})" ;;
    esac
  done
  if [ -z "${NOT_READY}" ]; then
    echo "Every stack ${CONSUMER_STACK} imports from is settled and exports what it needs."
    exit 0
  fi
  POLLS=$((POLLS + 1))
  if [ "${POLLS}" -ge "${WAIT_MAXIMUM_POLLS}" ]; then
    echo "Timed out after ${POLLS} polls waiting for:${NOT_READY}. Deploy those stacks (the control plane and thin-turn workflows) and run this workflow again." >&2
    exit 1
  fi
  echo "Not ready:${NOT_READY}; poll ${POLLS} of ${WAIT_MAXIMUM_POLLS}."
  sleep "${WAIT_POLL_SECONDS}"
done
