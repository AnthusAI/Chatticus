#!/bin/sh
# One-time deploy of one environment's GitHub deploy role into the production AWS account, where all three
# environments live. Production's ChatticusAccountDeploy has always created the account's one GitHub OIDC provider.
# Development's and staging's role stacks import that provider, so production must be deployed here first. Never
# --all. Run with the production account's credentials (profile chatticus-production), never legacy's.
set -eu

cd "$(dirname "$0")"

usage() {
  echo "usage: sh deploy-chatticus-account-deploy.sh development|staging|production" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
case "$1" in
  development) ENVIRONMENT="$1"; STACK="ChatticusAccountDeployDevelopment" ;;
  staging) ENVIRONMENT="$1"; STACK="ChatticusAccountDeployStaging" ;;
  production) ENVIRONMENT="$1"; STACK="ChatticusAccountDeploy" ;;
  *) usage ;;
esac

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ${STACK} deploy." >&2
  exit 1
fi

npx cdk deploy "${STACK}" --exclusively --require-approval never -c "githubDeployEnvironment=${ENVIRONMENT}"
