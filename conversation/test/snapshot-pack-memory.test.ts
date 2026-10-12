import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROBE = fileURLToPath(new URL("./support/pack-memory-probe.ts", import.meta.url));

type ProbeResult = { growth_megabytes: number; peak_rss_bytes: number; baseline_rss_bytes: number; uploaded_bytes: number; parts: number };

function probe(megabytes: number): ProbeResult {
	return JSON.parse(execFileSync(process.execPath, [PROBE, String(megabytes)], { encoding: "utf8", timeout: 240_000 })) as ProbeResult;
}

describe("snapshot pack memory", () => {
	it("keeps peak memory flat as the workspace grows from 50 MB to 200 MB", { timeout: 300_000 }, () => {
		const small = probe(50);
		const large = probe(200);
		console.log(`pack memory: 50 MB workspace grew RSS ${small.growth_megabytes} MB, 200 MB workspace grew RSS ${large.growth_megabytes} MB`);
		expect(large.uploaded_bytes).toBeGreaterThan(small.uploaded_bytes * 3);
		expect(large.parts).toBeGreaterThan(small.parts);
		expect(Math.abs(large.growth_megabytes - small.growth_megabytes)).toBeLessThan(150);
		expect(large.growth_megabytes).toBeLessThan(150);
	});
});
