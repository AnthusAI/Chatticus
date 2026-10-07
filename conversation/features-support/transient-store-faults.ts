import {
	ConditionalCheckFailedException,
	type DynamoDBClient,
	TransactionConflictException,
	TransactWriteItemsCommand,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

/** The two turn control writes a scenario can make fail. */
export type FaultedWrite = "closing" | "completion";

/** What an armed write fails with. */
export type FaultKind = "conflict" | "condition";

type Armed = { remaining: number; readonly kind: FaultKind };

/**
 * The turn control store's DynamoDB failures for one scenario: the next several attempts at one write fail with a
 * conflicting transaction or a failed condition, and every attempt that reaches the table is counted.
 */
export class TransientStoreFaults {
	private readonly armed = new Map<FaultedWrite, Armed>();
	private readonly attemptCounts = new Map<FaultedWrite, number>();

	/**
	 * Make the next attempts at a write fail.
	 *
	 * @param write Which write.
	 * @param attempts How many consecutive attempts fail.
	 * @param kind The failure.
	 */
	arm(write: FaultedWrite, attempts: number, kind: FaultKind): void {
		this.armed.set(write, { remaining: attempts, kind });
	}

	/** How many times a write reached the table, the failed attempts included. */
	attempts(write: FaultedWrite): number {
		return this.attemptCounts.get(write) ?? 0;
	}

	/**
	 * A client that fails armed writes before they reach the table.
	 *
	 * @param client The scenario's real client.
	 */
	wrap(client: DynamoDBClient): DynamoDBClient {
		return new Proxy(client, {
			get: (target, property, receiver) => {
				if (property !== "send") return Reflect.get(target, property, receiver);
				return (command: unknown, ...rest: unknown[]) => {
					const write = this.writeOf(command);
					if (write !== null) {
						this.attemptCounts.set(write, this.attempts(write) + 1);
						const failure = this.take(write);
						if (failure !== null) return Promise.reject(failure);
					}
					return (target.send as (...args: unknown[]) => unknown)(command, ...rest);
				};
			},
		});
	}

	private writeOf(command: unknown): FaultedWrite | null {
		if (command instanceof UpdateItemCommand && command.input.UpdateExpression === "SET closing = :closing") return "closing";
		if (command instanceof TransactWriteItemsCommand) {
			const items = (command.input.TransactItems ?? []) as Array<{ Put?: { Item?: { kind?: { S?: string } } } }>;
			if (items.some((item) => item.Put?.Item?.kind?.S === "turn.completed")) return "completion";
		}
		return null;
	}

	private take(write: FaultedWrite): Error | null {
		const armed = this.armed.get(write);
		if (armed === undefined || armed.remaining <= 0) return null;
		armed.remaining -= 1;
		if (armed.kind === "conflict") {
			return new TransactionConflictException({ message: "Transaction is ongoing for the item", $metadata: {} });
		}
		return new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
	}
}
