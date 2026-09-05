# Source after filling from CloudFormation/SSM. Do not commit secrets.
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
export CHATTICUS_ENVIRONMENT=development
export CHATTICUS_FRONT_DOOR_URL=https://<function-id>.lambda-url.us-east-1.on.aws/
export CHATTICUS_MESSAGING_TABLE=<MessagingTableName>
export CHATTICUS_TURN_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/<aws-account-id>/<TurnQueueName>
export CHATTICUS_COMPUTER_TURN_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/<aws-account-id>/<ComputerTurnQueueName>
export CHATTICUS_TURN_DEADLINE_SCHEDULE_GROUP=chatticus-development-turn-deadlines
export CHATTICUS_TURN_DEADLINE_TARGET_ARN=arn:aws:lambda:us-east-1:<aws-account-id>:function:chatticus-development-turn-deadline
export CHATTICUS_TURN_DEADLINE_ROLE_ARN=$(aws iam get-role --role-name chatticus-development-turn-deadline-scheduler --query Role.Arn --output text 2>/dev/null || true)
export CHATTICUS_SNAPSHOT_BUCKET=<snapshot-bucket-name>
export CHATTICUS_SPIKE_S3_PREFIX=spikes/0edb18
export CHATTICUS_TENANT_ID=spike-0edb18
export CHATTICUS_USER_ID=spike-runner
export CHATTICUS_WORKER_ID=spike-local-0edb18
# export CHATTICUS_INVOKE_KEY=            # from Secrets Manager InvokeKey output
# export CHATTICUS_INVOKE_KEY_SECRET_ARN= # optional alternative to inline key
