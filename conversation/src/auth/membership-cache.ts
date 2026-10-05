/** Time source injected so cache expiry is deterministic in tests. */
export type Clock = {
	nowMilliseconds(): number;
};

/** Warm-life membership cache: bounded, keyed `tenant:user`, expiring by TTL. */
export class MembershipCache<Value> {
	static readonly maximumEntries = 1000;
	static readonly timeToLiveMilliseconds = 30000;

	private readonly entries = new Map<string, { value: Value; expiresAt: number }>();

	private readonly clock: Clock;

	constructor(clock: Clock) {
		this.clock = clock;
	}

	get(tenantId: string, userId: string): Value | undefined {
		const key = `${tenantId}:${userId}`;
		const entry = this.entries.get(key);
		if (entry === undefined) {
			return undefined;
		}
		if (this.clock.nowMilliseconds() >= entry.expiresAt) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(tenantId: string, userId: string, value: Value): void {
		const key = `${tenantId}:${userId}`;
		this.entries.delete(key);
		if (this.entries.size >= MembershipCache.maximumEntries) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey !== undefined) {
				this.entries.delete(oldestKey);
			}
		}
		this.entries.set(key, {
			value,
			expiresAt: this.clock.nowMilliseconds() + MembershipCache.timeToLiveMilliseconds,
		});
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}
