import type { DataTable } from "@cucumber/cucumber";
import { CapabilityPolicy } from "../src/policy/capability-policy.ts";
import { PolicyControl } from "../src/policy/policy-control.ts";
import { POLICY_KERNEL_TENANT, POLICY_KERNEL_TURN } from "../src/policy/sinks.ts";
import { DynamoPolicyStore } from "../src/store/policy-store.ts";
import type { ChatticusWorld } from "./world.ts";

/**
 * The scenario's policy control, backed by the scenario's DynamoDB table and its messaging store.
 */
export function policyControlFor(world: ChatticusWorld): PolicyControl {
	if (world.policyControl === null) {
		world.policyControl = new PolicyControl({
			policyStore: new DynamoPolicyStore(world.messagingTable.client, world.messagingTable.tableName),
			store: world.messagingStore(),
			clock: world.clock,
			ids: world.ids,
		});
	}
	return world.policyControl;
}

/**
 * The capability policy the kernel-only scenarios share with the policy steps.
 */
export function kernelPolicyFor(world: ChatticusWorld): CapabilityPolicy {
	if (world.capabilityPolicy === null) {
		world.capabilityPolicy = policyControlFor(world).capabilityPolicyFor(POLICY_KERNEL_TENANT, POLICY_KERNEL_TURN);
	}
	return world.capabilityPolicy as CapabilityPolicy;
}

/**
 * Read a two-column Gherkin table, heading row included, as a map.
 */
export function tableAsMap(table: DataTable): Record<string, string> {
	const values: Record<string, string> = {};
	for (const row of table.raw()) {
		values[row[0].trim()] = row[1].trim();
	}
	return values;
}
