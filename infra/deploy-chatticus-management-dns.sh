#!/bin/sh
# One-time deploy of the chattic.us hosted zone into the management account.
# Never --all. Run with the management account's credentials, never legacy's.
# The records come from a local Route 53 export kept outside the repository
# (account-specific CloudFront hosts never enter a committed file).
set -eu

cd "$(dirname "$0")"

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: sh deploy-chatticus-management-dns.sh PATH_TO_ZONE_EXPORT.json" >&2
  exit 2
fi
ZONE_RECORDS_FILE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusManagementDns deploy." >&2
  exit 1
fi

npx cdk deploy ChatticusManagementDns --exclusively --require-approval never -c managementDns=true -c "zoneRecordsFile=${ZONE_RECORDS_FILE}"
