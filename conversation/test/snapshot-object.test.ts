import { describe, expect, it } from "vitest";
import { unpackCommitObject } from "../src/storage/snapshot-object.ts";
import {
	commitKey,
	commitPrefix,
	parseCommitKey,
	parseSnapshotKey,
	snapshotKey,
	snapshotPrefix,
} from "../src/storage/storage-support.ts";

describe("object keys", () => {
	it("round-trips a commit key through its sequence and fence", () => {
		const key = commitKey("tenant#bot#channel", 42, 7);
		expect(key.startsWith(commitPrefix("tenant#bot#channel"))).toBe(true);
		expect(parseCommitKey(key)).toEqual({ seq: 42, fence: 7 });
	});

	it("round-trips a snapshot key through its sequence and fence", () => {
		const key = snapshotKey("tenant#bot#channel", 99, 3);
		expect(key.startsWith(snapshotPrefix("tenant#bot#channel"))).toBe(true);
		expect(parseSnapshotKey(key)).toEqual({ seq: 99, fence: 3 });
	});

	it("keeps commit and snapshot keys apart", () => {
		expect(parseCommitKey(snapshotKey("s", 1, 1))).toBeUndefined();
		expect(parseSnapshotKey(commitKey("s", 1, 1))).toBeUndefined();
	});

	it("ignores keys that do not follow the convention", () => {
		expect(parseCommitKey("conversations/x/commits/readme.txt")).toBeUndefined();
	});
});

describe("unpackCommitObject", () => {
	it("restores each packed write at its original position", () => {
		const write = { type: "conversation", value: { id: 5 } } as never;
		const object = unpackCommitObject("s", "000000000009-00000002", { "3": write });
		expect(object.seq).toBe(9);
		expect(object.fence).toBe(2);
		expect(object.writes[3]).toBe(write);
		expect(object.writes[0]).toBeUndefined();
	});

	it("refuses a suffix that is not a commit suffix", () => {
		expect(() => unpackCommitObject("s", "nonsense", {})).toThrow("Malformed snapshot commit suffix");
	});
});
