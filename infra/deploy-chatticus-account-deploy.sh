#!/bin/sh
# One-time deploy of one environment's GitHub deploy role. Development's account
# also gets its OIDC provider here. Staging and production share one account whose
# provider is deployed once by deploy-chatticus-oidc-provider.sh, which must run
# first; each of the two then deploys its own role stack here. Never --all. Run
# with that account's credentials, never legacy's.
set -eu

cd "$(dirname "$0")"

usage() {
  echo "usage: sh deploy-chatticus-account-deploy.sh development|staging|production" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
case "$1" in
  development) ENVIRONMENT="$1"; STACK="ChatticusAccountDeploy" ;;
  staging) ENVIRONMENT="$1"; STACK="ChatticusAccountDeployStaging" ;;
  production) ENVIRONMENT="$1"; STACK="ChatticusAccountDeployProduction" ;;
  *) usage ;;
esac

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ${STACK} deploy." >&2
  exit 1
fi

npx cdk deploy "${STACK}" --exclusively --require-approval never -c "githubDeployEnvironment=${ENVIRONMENT}"
