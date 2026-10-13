import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
	OWNER_WATCHDOG_CHECK_SECONDS,
	OWNER_WATCHDOG_KILL_SECONDS,
	OWNER_WATCHDOG_STALE_SECONDS,
	OWNER_WATCHDOG_TERMINATE_SECONDS,
} from "@chatticus/host-protocol/supervisor";
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
		expect(bundleConfig).toContain('"file-helper"');
		expect(bundleConfig).toContain('".js": ".mjs"');
	});

	it("bundles the supervisor, the owner and the host worker from files the image copies, without the starter or the infra assets", async () => {
		const result = await build({
			entryPoints: {
				"host-worker": resolve(repositoryRoot, "computer", "host", "src", "main.ts"),
				owner: resolve(repositoryRoot, "computer", "host", "src", "owner-main.ts"),
				supervisor: resolve(repositoryRoot, "computer", "host", "src", "supervisor-main.ts"),
				snapshot: resolve(repositoryRoot, "conversation", "bin", "snapshot.ts"),
			},
			outdir: "unused",
			absWorkingDir: repositoryRoot,
			write: false,
			metafile: true,
			bundle: true,
			platform: "node",
			target: "node22",
			format: "esm",
			logLevel: "silent",
		});
		const copied = ["host-protocol/", "conversation/", "computer/host/", "node_modules/"];
		for (const [output, details] of Object.entries(result.metafile.outputs)) {
			for (const input of Object.keys(details.inputs)) {
				const relative = input;
				expect(copied.some((prefix) => relative.startsWith(prefix)), `${output} bundles ${relative}`).toBe(true);
				expect(relative, `${output} bundles the starter`).not.toMatch(/host-starter|customer-stack|customer-template|owner-start-driver|owner-credential-broker|client-lambda/);
			}
		}
		const supervisor = Object.entries(result.metafile.outputs).find(([output]) => output.endsWith("supervisor.js"));
		expect(supervisor, "the build produced no supervisor bundle").toBeDefined();
		for (const input of Object.keys(supervisor![1].inputs)) {
			expect(input, "the supervisor bundles Pi, the turn executor, the owner stores or an AWS client it has no use for").not.toMatch(
				/node_modules\/@earendil-works\/|conversation\/src\/pi\/(?!shell-environment\.ts)|conversation\/src\/turn\/|computer\/host\/src\/owner-deps|node_modules\/@aws-sdk\/client-(dynamodb|sts|lambda|secrets-manager|sqs|ecs)\//,
			);
		}
	});

	it("keeps the supervisor from opening a workspace path: the file runner and overlay applier modules import no file system module", () => {
		for (const name of ["live-file-operations.ts", "live-file-helper-launcher.ts", "overlay-applier.ts"]) {
			const source = readFileSync(resolve(repositoryRoot, "computer", "host", "src", name), "utf-8");
			expect(source, name).not.toMatch(/from "node:(fs|fs\/promises)"/);
		}
	});

	it("reads the overlay with the supervisor role and never writes or deletes in it: the blob reader and the applier call no put or delete", () => {
		for (const name of ["overlay-blob-reader.ts", "overlay-applier.ts"]) {
			const source = readFileSync(resolve(repositoryRoot, "computer", "host", "src", name), "utf-8");
			expect(source, name).not.toMatch(/\.(putIfAbsent|putIfMatch|delete)\(|PutObjectCommand|DeleteObjectCommand/);
		}
	});

	it("starts the supervisor from its own bundle and ships the watchdog as a separate program", () => {
		expect(bundleConfig).toContain("supervisor:");
		expect(dockerfile).toContain("COPY computer/chatticus-watchdog /usr/local/bin/chatticus-watchdog");
		expect(dockerfile).toMatch(/chmod 755[^\n]*\/usr\/local\/bin\/chatticus-watchdog/);
	});

	it("gives the watchdog the deadlines the protocol names and keeps it a POSIX shell script that holds no secret", () => {
		const watchdog = readFileSync(resolve(repositoryRoot, "computer", "chatticus-watchdog"), "utf-8");
		expect(watchdog.startsWith("#!/bin/sh\n")).toBe(true);
		expect(watchdog).toContain(`terminate_after=${OWNER_WATCHDOG_TERMINATE_SECONDS}`);
		expect(watchdog).toContain(`kill_after=${OWNER_WATCHDOG_KILL_SECONDS}`);
		expect(watchdog).toContain(`stale_after=${OWNER_WATCHDOG_STALE_SECONDS}`);
		expect(watchdog).toContain(`:-${OWNER_WATCHDOG_CHECK_SECONDS}}`);
		expect(watchdog).not.toMatch(/CHATTICUS_(OWNER_BOOTSTRAP_TOKEN|SUPERVISOR_TOKEN|INVOKE_KEY)|AWS_/);
	});

	it("installs git, certificates and a C toolchain and no display or browser packages", () => {
		for (const packageName of ["git", "ca-certificates", "build-essential"]) {
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

	it("bundles the owner program and runs model-chosen commands as an unprivileged user", () => {
		const launcher = readFileSync(resolve(repositoryRoot, "computer", "chatticus-shell"), "utf-8");
		expect(bundleConfig).toContain("owner:");
		expect(dockerfile).toContain("useradd --uid 2000");
		expect(dockerfile).toContain("COPY computer/chatticus-shell /usr/local/bin/chatticus-shell");
		expect(dockerfile).not.toMatch(/^USER /m);
		expect(launcher).toContain("--reuid=chatticus-shell");
		expect(launcher).toContain("--no-new-privs");
		expect(launcher).toContain("--bounding-set=-all");
	});
});
