#!/bin/sh
# One-time deploy of the GitHub OIDC identity provider into the AWS account that
# holds staging and production. AWS allows one provider per issuer per account, so
# this runs once for that account, before either environment's deploy role
# (deploy-chatticus-account-deploy.sh staging|production). Never --all. Run with
# that account's credentials, never the legacy account's.
set -eu

cd "$(dirname "$0")"

[ "$#" -eq 0 ] || {
  echo "usage: sh deploy-chatticus-oidc-provider.sh" >&2
  exit 2
}

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusGitHubOidcProvider deploy." >&2
  exit 1
fi

npx cdk deploy ChatticusGitHubOidcProvider --exclusively --require-approval never -c githubOidcProvider=true
