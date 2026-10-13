import { DynamoGatewayObservationSink, type GatewayObservation } from "../src/ledger/gateway-observation.ts";
import { DynamoObservationReconciler, type ObservationReconciler, type ReconcileOutcome } from "../src/ledger/reconcile.ts";
import { priceBookOf } from "./executor-harness.ts";
import type { ChatticusWorld } from "./world.ts";

/** The reconciler a scenario's daily rollup and reconciliation steps use, over the scenario's table, price book and clock. */
export function reconcilerOf(world: ChatticusWorld): ObservationReconciler {
	return new DynamoObservationReconciler({
		client: world.messagingTable.client,
		tableName: world.messagingTable.tableName,
		prices: priceBookOf(world),
		now: () => world.clock.now(),
	});
}

/** Keep one gateway observation exactly as the gateway would, without a real gateway call. */
export async function keepObservation(world: ChatticusWorld, observation: GatewayObservation): Promise<void> {
	await new DynamoGatewayObservationSink({ client: world.messagingTable.client, tableName: world.messagingTable.tableName }).record(observation);
}

const outcomes = new WeakMap<ChatticusWorld, ReconcileOutcome>();

/** Reconcile an organization's observations and remember what was found, for the steps that follow. */
export async function reconcileTenantOf(world: ChatticusWorld, tenantId: string): Promise<ReconcileOutcome> {
	const outcome = await reconcilerOf(world).reconcileTenant(tenantId);
	outcomes.set(world, outcome);
	return outcome;
}

/** What the last reconciliation of the scenario found. */
export function lastReconciliationOf(world: ChatticusWorld): ReconcileOutcome {
	const outcome = outcomes.get(world);
	if (outcome === undefined) throw new Error("No reconciliation has run in this scenario");
	return outcome;
}
