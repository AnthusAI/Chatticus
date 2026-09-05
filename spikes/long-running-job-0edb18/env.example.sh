# Source after filling secrets. Do not commit.
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
export CHATTICUS_ENVIRONMENT=development
export CHATTICUS_FRONT_DOOR_URL=https://wwfo67h32ahlhyaxs23p4rraba0fgxit.lambda-url.us-east-1.on.aws/
export CHATTICUS_MESSAGING_TABLE=ChatticusThinTurn-Messaging4C94D7F8-K6G2UNOUE8RB
export CHATTICUS_TURN_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/335163751677/ChatticusThinTurn-TurnJobsED2E664A-vWjcfUfVdVaN
export CHATTICUS_COMPUTER_TURN_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/335163751677/ChatticusThinTurn-ComputerTurnJobs46B2D1C6-eKrdDaIQXXZI
export CHATTICUS_TURN_DEADLINE_SCHEDULE_GROUP=chatticus-development-turn-deadlines
export CHATTICUS_TURN_DEADLINE_TARGET_ARN=arn:aws:lambda:us-east-1:335163751677:function:chatticus-development-turn-deadline
export CHATTICUS_TURN_DEADLINE_ROLE_ARN=$(aws iam get-role --role-name chatticus-development-turn-deadline-scheduler --query Role.Arn --output text 2>/dev/null || true)
export CHATTICUS_SNAPSHOT_BUCKET=chatticussnapshots-computersnapshotsb892d73f-r8qgykc9zjiq
export CHATTICUS_SPIKE_S3_PREFIX=spikes/0edb18
export CHATTICUS_TENANT_ID=spike-0edb18
export CHATTICUS_USER_ID=spike-runner
export CHATTICUS_WORKER_ID=spike-local-0edb18
# export CHATTICUS_INVOKE_KEY=            # from Secrets Manager InvokeKey output
# export CHATTICUS_INVOKE_KEY_SECRET_ARN= # optional alternative to inline key
