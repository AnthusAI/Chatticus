#!/bin/sh
# One-time deploy of one environment's GitHub deploy role into the production AWS account, where all three
# environments live. Production's ChatticusAccountDeploy has always created the account's one GitHub OIDC provider.
# Development's and staging's role stacks import that provider, so production must be deployed here first. Never
# --all. Run with the production account's credentials (profile chatticus-production), never legacy's.
#
# Order for a new environment: its integration test role reads the thin-turn invoke key secret parameter
# (/chatticus/ENV/thin-turn/invoke-key-secret-arn) while CloudFormation deploys, so ChatticusAccountDeployDevelopment
# (or Staging) can only be deployed AFTER that environment's thin-turn stack exists. The first stacks of a new
# environment are deployed by an admin session; CI takes over once this stack and the GitHub environment secrets exist.
# Production's ChatticusAccountDeploy is not redeployed as part of adding development.
#
# The script refuses unless the caller's account has the CDKToolkit stack and, for development and staging, production's
# ChatticusAccountDeploy stack (the one that owns the shared OIDC provider), i.e. it is the shared production account.
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

if aws cloudformation describe-stacks --stack-name ChatticusDns >/dev/null 2>&1; then
  echo "Refusing: this account has the legacy ChatticusDns stack. Use the production account's credentials." >&2
  exit 1
fi
if ! aws cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1; then
  echo "Refusing: this account has no CDKToolkit stack (it is not bootstrapped). Use the production account's credentials." >&2
  exit 1
fi
if [ "${ENVIRONMENT}" != "production" ] && ! aws cloudformation describe-stacks --stack-name ChatticusAccountDeploy >/dev/null 2>&1; then
  echo "Refusing: this account has no production ChatticusAccountDeploy stack, so it is not the shared production account (it owns the GitHub OIDC provider ${STACK} imports)." >&2
  exit 1
fi

npx cdk deploy "${STACK}" --exclusively --require-approval never -c "githubDeployEnvironment=${ENVIRONMENT}"
