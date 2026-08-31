#!/bin/sh
# Hit a named live ThinTurn stack. Not CI. Costs only the existing
# per-request Lambdas, Dynamo, SQS, and CloudFront. Does not scale Fargate.
set -eu

cd "$(dirname "$0")/.."

environment="${1:-development}"
case "$environment" in
  development|staging|production) ;;
  *)
    echo "usage: sh live_aws_thin_turn.sh [development|staging|production]" >&2
    exit 2
    ;;
esac

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before live AWS thin-turn acceptance." >&2
  exit 1
fi

user_id="dev-$(id -un 2>/dev/null || echo agent)-$$"
exec python scripts/exercise_thin_turn.py \
  --environment "$environment" \
  --user-id "$user_id"
