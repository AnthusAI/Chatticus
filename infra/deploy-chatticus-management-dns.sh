#!/bin/sh
# One-time deploy of the chattic.us hosted zone into the management account.
# Never --all. Run with the management account's credentials, never legacy's.
set -eu

cd "$(dirname "$0")"

if [ "${1:-}" != "" ]; then
  echo "usage: sh deploy-chatticus-management-dns.sh" >&2
  exit 2
fi

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusManagementDns deploy." >&2
  exit 1
fi

npx cdk deploy ChatticusManagementDns --exclusively --require-approval never -c managementDns=true
