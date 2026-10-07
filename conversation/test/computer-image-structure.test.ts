import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(resolve(repositoryRoot, "computer", "Dockerfile"), "utf-8");
const entrypoint = readFileSync(resolve(repositoryRoot, "computer", "entrypoint.sh"), "utf-8");
const bundleConfig = readFileSync(resolve(repositoryRoot, "computer", "host", "esbuild.config.mjs"), "utf-8");

describe("computer image structure", () => {
	it("uses the Node base image", () => {
		expect(dockerfile).toContain("FROM node:22-bookworm-slim");
	});

	it("bundles the host worker and the snapshot program to /opt/chatticus/host", () => {
		expect(dockerfile).toContain("CHATTICUS_HOST_BUNDLE_DIR=/opt/chatticus/host");
		expect(dockerfile).toContain("COPY --from=host-bundle /opt/chatticus/host /opt/chatticus/host");
		expect(bundleConfig).toContain('"host-worker"');
		expect(bundleConfig).toContain("snapshot:");
		expect(bundleConfig).toContain('".js": ".mjs"');
	});

	it("installs git and certificates and no display or browser packages", () => {
		for (const packageName of ["git", "ca-certificates"]) {
			expect(dockerfile).toMatch(new RegExp(`^\\s+${packageName} \\\\$`, "m"));
		}
		for (const packageName of ["xvfb", "x11-utils", "chromium", "fonts-liberation"]) {
			expect(dockerfile).not.toMatch(new RegExp(`^\\s+${packageName}\\b`, "m"));
		}
	});

	it("starts no display in the entrypoint", () => {
		expect(entrypoint).not.toMatch(/xvfb|xdpyinfo|DISPLAY/i);
	});

	it("contains no python or pip", () => {
		expect(dockerfile.toLowerCase()).not.toMatch(/python|\bpip\b/);
	});

	it("execs node and never python in the entrypoint", () => {
		expect(entrypoint).toContain("node /opt/chatticus/host/snapshot.mjs pack");
		expect(entrypoint).not.toMatch(/python/i);
		expect(entrypoint).toContain('exec "$@"');
	});
});
