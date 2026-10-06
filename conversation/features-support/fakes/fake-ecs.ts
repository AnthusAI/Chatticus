import type { AssumeRolePort, EcsPort, EcsRunTaskInput } from "../../src/computer/aws-ports.ts";

/** ECS, faked at the SDK boundary: it records every RunTask it is asked for and starts one task for each. */
export class FakeEcs implements EcsPort {
	readonly runTaskCalls: EcsRunTaskInput[] = [];

	async runTask(input: EcsRunTaskInput): Promise<{ tasks?: unknown[]; failures?: unknown[] }> {
		this.runTaskCalls.push(input);
		return { tasks: [{ taskArn: `arn:aws:ecs:task/${this.runTaskCalls.length}` }], failures: [] };
	}
}

/** STS AssumeRole, faked: it records every call and answers with fixed temporary credentials. */
export class FakeAssumeRole {
	readonly calls: Array<Parameters<AssumeRolePort>[0]> = [];

	readonly port: AssumeRolePort = async (input) => {
		this.calls.push(input);
		return {
			Credentials: {
				AccessKeyId: "ASIAFAKE",
				SecretAccessKey: "fake-secret",
				SessionToken: "fake-token",
				Expiration: new Date("2026-08-31T07:00:00Z"),
			},
		};
	};
}
