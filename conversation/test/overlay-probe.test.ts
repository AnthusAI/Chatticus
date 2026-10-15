import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runOverlayProbe } from "../../computer/host/src/owner.ts";
import { SOURCE_FILE_HELPER_COMMAND } from "../src/pi/unprivileged-execution-env.ts";

const sha256Of = (text: string): string => createHash("sha256").update(text).digest("hex");

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const common = (path: string) => ({ path, revision: 1, edited_by: "mia", edited_at: "2026-10-12T08:00:00.000Z", conflict: null });

describe("the overlay probe the container script runs", () => {
	it("applies an edit, a new file and a delete through the helper and reports a link that leads outside the workspace as a conflict", async () => {
		const root = mkdtempSync(join(tmpdir(), "overlay-probe-"));
		directories.push(root);
		const workspace = join(root, "workspace");
		const blobs = join(root, "blobs");
		mkdirSync(workspace);
		mkdirSync(blobs);
		writeFileSync(join(workspace, "edit.txt"), "edit-me");
		writeFileSync(join(workspace, "gone.txt"), "gone");
		writeFileSync(join(root, "secret"), "root-only\n");
		symlinkSync(join(root, "secret"), join(workspace, "leak"));
		for (const text of ["edited-by-mia", "created-by-mia", "planted"]) writeFileSync(join(blobs, sha256Of(text)), text);
		const put = (path: string, text: string, base: string | null) => ({
			...common(path),
			op: "put",
			sha256: sha256Of(text),
			size: text.length,
			mode: "664",
			base_sha256: base,
			from: null,
			from_sha256: null,
		});
		const entries = [
			put("/workspace/edit.txt", "edited-by-mia", sha256Of("edit-me")),
			put("/workspace/created.txt", "created-by-mia", null),
			put("/workspace/leak", "planted", sha256Of("root-only\n")),
			{ ...common("/workspace/gone.txt"), op: "delete", directory: false, recursive: false, base_sha256: sha256Of("gone"), tree_sha256: null },
		];
		const entriesFile = join(root, "entries.json");
		writeFileSync(entriesFile, JSON.stringify(entries));
		const result = await runOverlayProbe(entriesFile, blobs, { workspaceRoot: workspace, shellLauncherPath: "/bin/sh", fileHelperCommand: SOURCE_FILE_HELPER_COMMAND });
		expect(result.applied.map((entry) => entry.path).sort()).toEqual(["/workspace/created.txt", "/workspace/edit.txt", "/workspace/gone.txt"]);
		expect(result.conflicts).toMatchObject([{ path: "/workspace/leak", reason: "kind_mismatch" }]);
		expect(readFileSync(join(workspace, "edit.txt"), "utf8")).toBe("edited-by-mia");
		expect(readFileSync(join(workspace, "created.txt"), "utf8")).toBe("created-by-mia");
		expect(readFileSync(join(root, "secret"), "utf8")).toBe("root-only\n");
	});
});
