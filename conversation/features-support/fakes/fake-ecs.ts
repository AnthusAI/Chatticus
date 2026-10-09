import type { AssumeRolePort, EcsPort, EcsRunTaskInput, ScopedAssumeRolePort } from "../../src/computer/aws-ports.ts";

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

/** The scoped credentials the fake STS hands out; scenarios check that no log ever carries them. */
export const FAKE_SCOPED_CREDENTIALS = {
	AccessKeyId: "scoped-owner-access-key-id-2a6f",
	SecretAccessKey: "scoped-owner-secret-access-key-7c1e",
	SessionToken: "scoped-owner-session-token-4b9d",
} as const;

/** STS AssumeRole with a session policy, faked: it records every call and answers with fixed scoped credentials. */
export class FakeStsAssumeRole {
	readonly calls: Array<Parameters<ScopedAssumeRolePort>[0]> = [];

	readonly port: ScopedAssumeRolePort = async (input) => {
		this.calls.push(input);
		return { Credentials: { ...FAKE_SCOPED_CREDENTIALS, Expiration: new Date("2026-08-31T08:00:00Z") } };
	};
}
