#!/bin/sh
# One-time deploy of the GitHub OIDC provider and deploy role into one
# dedicated environment account. Never --all. Pass the environment that account
# serves. Run with that account's credentials, never legacy's.
set -eu

cd "$(dirname "$0")"

usage() {
  echo "usage: sh deploy-chatticus-account-deploy.sh development|staging|production" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
case "$1" in
  development | staging | production) ENVIRONMENT="$1" ;;
  *) usage ;;
esac

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusAccountDeploy deploy." >&2
  exit 1
fi

npx cdk deploy ChatticusAccountDeploy --exclusively --require-approval never -c "githubDeployEnvironment=${ENVIRONMENT}"
