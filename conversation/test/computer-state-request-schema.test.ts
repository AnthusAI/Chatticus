import { describe, expect, it } from "vitest";
import { computerStateRequestSchema } from "@chatticus/host-protocol";

describe("computerStateRequestSchema start generation", () => {
	it("accepts a stopped report that names a positive start generation", () => {
		expect(computerStateRequestSchema.parse({ stopped: true, start_generation: 3 })).toEqual({ stopped: true, start_generation: 3 });
	});

	it("refuses a start generation on a running report, a zero generation and a fractional one", () => {
		expect(computerStateRequestSchema.safeParse({ stopped: false, start_generation: 3 }).success).toBe(false);
		expect(computerStateRequestSchema.safeParse({ stopped: true, start_generation: 0 }).success).toBe(false);
		expect(computerStateRequestSchema.safeParse({ stopped: true, start_generation: 1.5 }).success).toBe(false);
		expect(computerStateRequestSchema.safeParse({ capability_ready: "model", start_generation: 1 }).success).toBe(false);
	});
});
