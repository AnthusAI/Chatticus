/** The default number of immutable Pi commit objects the front door keeps in memory. */
export const MESSAGE_CACHE_CAPACITY = 500;

/**
 * A least-recently-used cache over a Map-shaped interface. It holds the bodies of Pi commit objects keyed by their S3
 * object key. Those objects are immutable, so an entry never goes stale and the only eviction is by capacity.
 */
export class MessageBodyCache<Value> {
	private readonly entries = new Map<string, Value>();
	private readonly capacity: number;

	/**
	 * @param capacity The most entries kept; the least recently used entry beyond it is dropped.
	 */
	constructor(capacity: number = MESSAGE_CACHE_CAPACITY) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new Error(`message cache capacity must be a positive integer, got ${capacity}`);
		}
		this.capacity = capacity;
	}

	/** The number of entries held. */
	get size(): number {
		return this.entries.size;
	}

	/**
	 * Look up an entry and mark it most recently used.
	 *
	 * @param objectKey The S3 object key.
	 * @returns The cached value, or undefined.
	 */
	get(objectKey: string): Value | undefined {
		const value = this.entries.get(objectKey);
		if (value === undefined) return undefined;
		this.entries.delete(objectKey);
		this.entries.set(objectKey, value);
		return value;
	}

	/**
	 * Store an entry as most recently used, evicting the least recently used one when over capacity.
	 *
	 * @param objectKey The S3 object key.
	 * @param value The value to keep.
	 * @returns This cache.
	 */
	set(objectKey: string, value: Value): this {
		this.entries.delete(objectKey);
		this.entries.set(objectKey, value);
		if (this.entries.size > this.capacity) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
		return this;
	}

	/**
	 * Drop an entry.
	 *
	 * @param objectKey The S3 object key.
	 * @returns Whether an entry was dropped.
	 */
	delete(objectKey: string): boolean {
		return this.entries.delete(objectKey);
	}
}
