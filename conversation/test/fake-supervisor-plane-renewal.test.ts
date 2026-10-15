import { ownerCredentialsResponseSchema } from "@chatticus/host-protocol/supervisor";
import { describe, expect, it } from "vitest";
import { FakeSupervisorClock } from "../features-support/fakes/fake-supervisor-clock.ts";
import { FakeSupervisorPlane, ownerRouteRefusal } from "../features-support/fakes/fake-supervisor-plane.ts";

const supervisorRequest = { kind: "supervisor", owner_id: "owner-1", generation: 3 } as const;
const turnRequest = { kind: "turn", owner_id: "owner-1", generation: 3, dispatch_id: "dispatch-1", turn_id: "turn-1" } as const;

function setup(): { plane: FakeSupervisorPlane; clock: FakeSupervisorClock } {
	const clock = new FakeSupervisorClock();
	return { plane: new FakeSupervisorPlane(clock), clock };
}

describe("FakeSupervisorPlane credential renewal", () => {
	it("answers each kind with a set that parses and ends in an hour, and records the request", async () => {
		const { plane, clock } = setup();
		const supervisor = await plane.renewCredentials(supervisorRequest);
		const turn = await plane.renewCredentials(turnRequest);
		expect(ownerCredentialsResponseSchema.safeParse(supervisor).success).toBe(true);
		expect(ownerCredentialsResponseSchema.safeParse(turn).success).toBe(true);
		expect(turn).toMatchObject({ kind: "turn", dispatch_id: "dispatch-1", turn_id: "turn-1" });
		expect(supervisor.kind === "supervisor" && supervisor.aws_credentials.expires_at).toBe(new Date(clock.nowMilliseconds() + 3600_000).toISOString());
		expect(plane.renewals.map((recorded) => recorded.request.kind)).toEqual(["supervisor", "turn"]);
	});

	it("answers a script in turn, fails when told to, and records a failed request too", async () => {
		const { plane } = setup();
		plane.renewalScript = [ownerRouteRefusal(409, "owner_draining")];
		await expect(plane.renewCredentials(supervisorRequest)).rejects.toMatchObject({ status: 409, code: "owner_draining" });
		await expect(plane.renewCredentials(supervisorRequest)).resolves.toMatchObject({ kind: "supervisor" });
		plane.renewalsFailWith = new Error("network down");
		await expect(plane.renewCredentials(turnRequest)).rejects.toThrow("network down");
		expect(plane.renewals).toHaveLength(3);
	});

	it("holds the next request until released", async () => {
		const { plane } = setup();
		const release = plane.holdNextRenewal();
		let answered = false;
		const pending = plane.renewCredentials(supervisorRequest).then((response) => {
			answered = true;
			return response;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(plane.renewals).toHaveLength(1);
		expect(answered).toBe(false);
		release();
		await expect(pending).resolves.toMatchObject({ kind: "supervisor" });
	});

	it("waits the scripted fake time before it answers", async () => {
		const { plane, clock } = setup();
		plane.renewalDelayMilliseconds = 5000;
		let answered = false;
		const pending = plane.renewCredentials(supervisorRequest).then((response) => {
			answered = true;
			return response;
		});
		await clock.advance(4000);
		expect(answered).toBe(false);
		await clock.advance(1000);
		await pending;
		expect(answered).toBe(true);
	});
});
