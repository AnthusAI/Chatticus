import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import { S3SnapshotStore } from "../../src/snapshot/s3.ts";
import { streamLiveDisk } from "../../src/snapshot/pack.ts";
import { snapshotUri } from "../../src/snapshot/uri.ts";

const FILE_BYTES = 5 * 1024 * 1024;

const targetMegabytes = Number(process.argv[2]);
if (!Number.isFinite(targetMegabytes) || targetMegabytes <= 0) {
	throw new Error("Usage: pack-memory-probe.ts <megabytes>");
}

const root = mkdtempSync(join(tmpdir(), "pack-memory-probe-"));

try {
	mkdirSync(join(root, "workspace", "data"), { recursive: true });
	const template = randomBytes(FILE_BYTES);
	const fileCount = Math.ceil((targetMegabytes * 1024 * 1024) / FILE_BYTES);
	for (let number = 0; number < fileCount; number += 1) {
		template.writeUInt32LE(number, 0);
		writeFileSync(join(root, "workspace", "data", `blob-${number}.bin`), template);
	}
	for (let number = 0; number < 300; number += 1) {
		writeFileSync(join(root, "workspace", "data", `small-${number}.txt`), `small file ${number}\n`.repeat(40));
	}

	let uploadedBytes = 0;
	let parts = 0;
	const discardingClient = {
		send: async (command: { constructor: { name: string }; input: { Body?: Buffer } }) => {
			const name = command.constructor.name;
			if (name === "UploadPartCommand" || name === "PutObjectCommand") {
				uploadedBytes += command.input.Body?.length ?? 0;
				parts += 1;
			}
			if (name === "CreateMultipartUploadCommand") return { UploadId: "probe" };
			if (name === "UploadPartCommand") return { ETag: `"etag-${parts}"` };
			return {};
		},
	} as unknown as S3Client;

	const baselineRss = process.memoryUsage().rss;
	let peakRss = baselineRss;
	const sampler = setInterval(() => {
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
	}, 20);

	const store = new S3SnapshotStore("probe-bucket", discardingClient);
	const live = streamLiveDisk(root);
	await store.putPack(snapshotUri("tenant", "computer", { bucket: "probe-bucket" }), live.chunks);
	clearInterval(sampler);
	peakRss = Math.max(peakRss, process.memoryUsage().rss);

	console.log(
		JSON.stringify({
			workspace_megabytes: targetMegabytes,
			baseline_rss_bytes: baselineRss,
			peak_rss_bytes: peakRss,
			growth_megabytes: Math.round((peakRss - baselineRss) / 1024 / 1024),
			uploaded_bytes: uploadedBytes,
			parts,
			entries: live.result().index.entries.length,
		}),
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
