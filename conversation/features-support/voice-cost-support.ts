import { type DynamoDBClient, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import type { VoiceCostRecordingFailure } from "../src/domain/voice-messages.ts";
import type { VendorLedgerDependencies } from "../src/ledger/vendor-ledger.ts";
import { ledgerDependenciesFor, priceBookOf } from "./executor-harness.ts";
import type { ChatticusWorld } from "./world.ts";

type VoiceCostScenario = { broken: boolean; readonly failures: VoiceCostRecordingFailure[] };

const scenarios = new WeakMap<ChatticusWorld, VoiceCostScenario>();

function scenarioOf(world: ChatticusWorld): VoiceCostScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { broken: false, failures: [] };
		scenarios.set(world, scenario);
	}
	return scenario;
}

/** Make every write of a voice understanding cost fail from now on, as a table that stopped answering would. */
export function breakVoiceCostRecording(world: ChatticusWorld): void {
	scenarioOf(world).broken = true;
}

/** The voice cost recording failures the scenario's front door has reported. */
export const voiceCostFailuresOf = (world: ChatticusWorld): readonly VoiceCostRecordingFailure[] => scenarioOf(world).failures;

/** What the scenario's front door tells when a voice cost could not be recorded. */
export const voiceCostFailureReporterOf =
	(world: ChatticusWorld) =>
	(failure: VoiceCostRecordingFailure): void => {
		scenarioOf(world).failures.push(failure);
	};

/** The ledger the voice route records into: the scenario's ledger, whose cost writes fail once a step breaks them. */
export function voiceLedgerFor(world: ChatticusWorld): VendorLedgerDependencies {
	const scenario = scenarioOf(world);
	const base = ledgerDependenciesFor(world);
	const client = new Proxy(base.client, {
		get(target, property, receiver) {
			if (property !== "send") return Reflect.get(target, property, receiver);
			return (command: unknown, ...rest: unknown[]) => {
				if (scenario.broken && command instanceof TransactWriteItemsCommand) {
					return Promise.reject(Object.assign(new Error("the table did not answer"), { name: "ServiceUnavailable" }));
				}
				return (target.send as (...args: unknown[]) => unknown)(command, ...rest);
			};
		},
	}) as DynamoDBClient;
	return {
		client,
		tableName: base.tableName,
		now: base.now,
		get prices() {
			return priceBookOf(world);
		},
	};
}
