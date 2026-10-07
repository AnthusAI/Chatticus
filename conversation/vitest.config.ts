import { defineConfig } from "vitest/config";

/** Tests talk to a moto container over HTTP; the default 5 second limit flakes on loaded runners. */
export default defineConfig({
	test: {
		testTimeout: 30000,
		hookTimeout: 30000,
	},
});
