/** Tunables of the token coalescer; the defaults are the design's about 250 ms or 200 bytes. */
export type TokenCoalescerOptions = {
	readonly flushBytes: number;
	readonly flushMilliseconds: number;
	/** Called with each coalesced piece of text, in order, one at a time. */
	readonly write: (text: string) => Promise<void>;
};

/** Bytes at which buffered text is written at once. */
export const DEFAULT_TOKEN_FLUSH_BYTES = 200;

/** Milliseconds after which buffered text is written however small. */
export const DEFAULT_TOKEN_FLUSH_MILLISECONDS = 250;

/**
 * Collects streamed text and hands it on in larger pieces: a piece is written once it reaches the byte threshold, or a
 * timer started by its first fragment expires. Writes are serialized, so text reaches the sink in order, and an error
 * from the sink surfaces on the next `flush`.
 */
export class TokenCoalescer {
	private readonly options: TokenCoalescerOptions;
	private buffer = "";
	private timer: ReturnType<typeof setTimeout> | null = null;
	private chain: Promise<void> = Promise.resolve();
	private failure: unknown = null;

	/** @param options Thresholds and the sink. */
	constructor(options: TokenCoalescerOptions) {
		this.options = options;
	}

	/** Add streamed text; never throws. */
	push(text: string): void {
		if (text === "") return;
		this.buffer += text;
		if (Buffer.byteLength(this.buffer) >= this.options.flushBytes) {
			this.schedule();
			return;
		}
		if (this.timer === null) {
			this.timer = setTimeout(() => {
				this.timer = null;
				this.schedule();
			}, this.options.flushMilliseconds);
		}
	}

	/**
	 * Write whatever is buffered and wait for every earlier write.
	 *
	 * @throws The first error the sink raised since the last flush.
	 */
	async flush(): Promise<void> {
		this.schedule();
		await this.chain;
		if (this.failure !== null) {
			const failure = this.failure;
			this.failure = null;
			throw failure;
		}
	}

	private schedule(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const text = this.buffer;
		this.buffer = "";
		if (text === "") return;
		this.chain = this.chain.then(async () => {
			try {
				await this.options.write(text);
			} catch (error) {
				this.failure ??= error;
			}
		});
	}
}
