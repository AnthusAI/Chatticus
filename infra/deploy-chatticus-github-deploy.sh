#!/bin/sh
# One-time (or rare) deploy of the GitHub Actions OIDC deploy role. Never --all.
set -eu

cd "$(dirname "$0")"

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusGitHubDeploy deploy." >&2
  exit 1
fi

npx cdk deploy ChatticusGitHubDeploy --require-approval never
