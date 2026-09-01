#!/bin/sh
# Deploy shared DNS for chattic.us. After deploy, set the registrar name
# servers to the NameServers stack output.
set -eu

cd "$(dirname "$0")"

if [ "${1:-}" != "" ]; then
  echo "usage: sh deploy-chatticus-dns.sh" >&2
  exit 2
fi

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusDns deploy." >&2
  exit 1
fi

# shellcheck source=budgets-deploy-context.sh
. "$(dirname "$0")/budgets-deploy-context.sh"

# shellcheck disable=SC2086
npx cdk deploy ChatticusDns --require-approval never ${BUDGETS_CDK_CONTEXT}

echo ""
echo "Set the chattic.us registrar name servers to the NameServers output above."
echo "ACM validation completes after delegation propagates (often under an hour)."
