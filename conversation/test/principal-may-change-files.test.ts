import { describe, expect, it } from "vitest";
import type { PrincipalKind } from "../src/auth/principal.ts";
import { principalMayChangeFiles } from "../src/http/routes/computer-files.ts";

const allKinds: PrincipalKind[] = ["user", "operator", "worker", "integration"];

describe("principalMayChangeFiles", () => {
	it.each(["user", "integration"] as PrincipalKind[])("accepts a %s principal with a user id", (kind) => {
		expect(principalMayChangeFiles({ kind, userId: "someone" })).toBe(true);
	});

	it.each(allKinds)("refuses a %s principal without a user id", (kind) => {
		expect(principalMayChangeFiles({ kind, userId: null })).toBe(false);
	});

	it.each(["operator", "worker"] as PrincipalKind[])("refuses a %s principal even with a user id", (kind) => {
		expect(principalMayChangeFiles({ kind, userId: "someone" })).toBe(false);
	});
});
