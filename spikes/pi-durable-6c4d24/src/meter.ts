import type { AttributeValue } from "@aws-sdk/client-dynamodb";

type Item = Record<string, AttributeValue>;

const LOCAL_INDEXES = ["l1", "l2", "l3"] as const;

/**
 * Approximate DynamoDB item size: attribute names plus string and number values, as DynamoDB bills them.
 *
 * @param item Item.
 * @returns Bytes.
 */
export function itemSize(item: Item): number {
	let total = 0;
	for (const [name, value] of Object.entries(item)) {
		total += Buffer.byteLength(name);
		if (value.S !== undefined) total += Buffer.byteLength(value.S);
		else if (value.N !== undefined) total += Math.ceil(value.N.replace(/^-/, "").length / 2) + 1;
		else if (value.BOOL !== undefined) total += 1;
		else total += 8;
	}
	return total;
}

const writeUnits = (bytes: number) => Math.max(1, Math.ceil(bytes / 1024));
const readUnits = (bytes: number) => Math.max(1, Math.ceil(bytes / 4096));
const indexCount = (item: Item) => LOCAL_INDEXES.filter((name) => item[name] !== undefined).length;

/**
 * Request and capacity accounting for one storage, estimated from the requests themselves with DynamoDB's on-demand
 * rules: 1 WRU per started KB written (twice inside a transaction), 1 more per local index an item lands in, and 1
 * RRU per started 4 KB strongly consistent read, summed per request for queries. moto does not report consumed
 * capacity, so these are estimates.
 */
export class Meter {
	dynamoRequests = 0;
	writeRequestUnits = 0;
	readRequestUnits = 0;
	s3Puts = 0;
	s3Gets = 0;
	s3BytesPut = 0;
	largestIndexItemBytes = 0;

	/**
	 * Count one transactional write of these items.
	 *
	 * @param items Put items, or for updates and condition checks the approximate item written or read.
	 */
	transaction(items: readonly Item[]): void {
		this.dynamoRequests++;
		for (const item of items) {
			const bytes = itemSize(item);
			this.largestIndexItemBytes = Math.max(this.largestIndexItemBytes, bytes);
			this.writeRequestUnits += 2 * writeUnits(bytes) + indexCount(item) * writeUnits(bytes);
		}
	}

	/** Count one non-transactional write per item, for example a batch of deletes or a single put. */
	writes(items: readonly Item[]): void {
		this.dynamoRequests++;
		for (const item of items) this.writeRequestUnits += writeUnits(itemSize(item)) * (1 + indexCount(item));
	}

	/** Count one strongly consistent read request that returned these items. */
	read(items: readonly Item[], perItem: boolean): void {
		this.dynamoRequests++;
		if (perItem) {
			this.readRequestUnits += Math.max(1, items.reduce((sum, item) => sum + readUnits(itemSize(item)), 0));
		} else {
			this.readRequestUnits += readUnits(items.reduce((sum, item) => sum + itemSize(item), 0));
		}
	}

	snapshot() {
		return {
			dynamoRequests: this.dynamoRequests,
			writeRequestUnits: this.writeRequestUnits,
			readRequestUnits: this.readRequestUnits,
			s3Puts: this.s3Puts,
			s3Gets: this.s3Gets,
			s3BytesPut: this.s3BytesPut,
			largestIndexItemBytes: this.largestIndexItemBytes,
		};
	}
}

export type MeterSnapshot = ReturnType<Meter["snapshot"]>;

/**
 * Difference of two meter snapshots.
 *
 * @param after Later snapshot.
 * @param before Earlier snapshot.
 * @returns Counts in between; the largest item is the later value.
 */
export function meterDelta(after: MeterSnapshot, before: MeterSnapshot): MeterSnapshot {
	return {
		dynamoRequests: after.dynamoRequests - before.dynamoRequests,
		writeRequestUnits: after.writeRequestUnits - before.writeRequestUnits,
		readRequestUnits: after.readRequestUnits - before.readRequestUnits,
		s3Puts: after.s3Puts - before.s3Puts,
		s3Gets: after.s3Gets - before.s3Gets,
		s3BytesPut: after.s3BytesPut - before.s3BytesPut,
		largestIndexItemBytes: after.largestIndexItemBytes,
	};
}

/**
 * Resident DynamoDB storage of one partition as DynamoDB bills it: each item plus 100 bytes, and again for each
 * local index the item appears in (projection ALL).
 *
 * @param items Every item of the partition.
 * @returns Billable bytes.
 */
export function residentBytes(items: readonly Item[]): number {
	return items.reduce((sum, item) => sum + (itemSize(item) + 100) * (1 + indexCount(item)), 0);
}
