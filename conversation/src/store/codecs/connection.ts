/**
 * Codecs for Connection items: one proposal, its routing outcome, and the authorized clip when it has one.
 * Ported from python/src/chatticus/authorized_connections.py lines 29-89.
 * Item keys: pk `{granting tenant}#connections`, sk `CONN#<proposal id>`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type {
	AuthorizedConnection,
	ConnectionProposal,
	ConnectionProposalStatus,
} from "../../policy/connections.ts";
import { connectionKey } from "../keys.ts";
import { formatIsoDateTime } from "./util.ts";
import { requireString } from "./list-util.ts";

export type Item = Record<string, AttributeValue>;

/** One proposal with the route it was given and the clip it produced, if any. */
export interface ConnectionRecord {
	proposal: ConnectionProposal;
	status: ConnectionProposalStatus | null;
	escalationTargetUserId: string | null;
	authorized: AuthorizedConnection | null;
}

/**
 * Encode a connection record to a DynamoDB item.
 * @param value Connection record to encode.
 * @returns DynamoDB item.
 */
export function encode(value: ConnectionRecord): Item {
	const proposal = value.proposal;
	const key = connectionKey(proposal.grantingTenantId, proposal.proposalId);
	const item: Item = {
		pk: { S: key.pk },
		sk: { S: key.sk },
		proposal_id: { S: proposal.proposalId },
		granting_tenant_id: { S: proposal.grantingTenantId },
		receiving_tenant_id: { S: proposal.receivingTenantId },
		channel_id: { S: proposal.channelId },
		channel_name: { S: proposal.channelName },
		permission: { S: proposal.permission },
		proposer_user_id: { S: proposal.proposerUserId },
	};
	if (value.status !== null) {
		item.status = { S: value.status };
	}
	if (value.escalationTargetUserId !== null) {
		item.escalation_target_user_id = { S: value.escalationTargetUserId };
	}
	if (value.authorized !== null) {
		item.connection_id = { S: value.authorized.connectionId };
		item.clipped_by_user_id = { S: value.authorized.clippedByUserId };
		item.created_at = { S: formatIsoDateTime(value.authorized.createdAt) };
	}
	return item;
}

/**
 * Decode a connection record from a DynamoDB item.
 * @param item DynamoDB item.
 * @returns Decoded connection record.
 * @throws Error if required attributes are missing.
 */
export function decode(item: Item): ConnectionRecord {
	const proposal: ConnectionProposal = {
		proposalId: requireString(item, "proposal_id", "connection"),
		grantingTenantId: requireString(item, "granting_tenant_id", "connection"),
		receivingTenantId: requireString(item, "receiving_tenant_id", "connection"),
		channelId: requireString(item, "channel_id", "connection"),
		channelName: requireString(item, "channel_name", "connection"),
		permission: requireString(item, "permission", "connection"),
		proposerUserId: requireString(item, "proposer_user_id", "connection"),
	};
	const connectionId = item.connection_id?.S;
	const authorized: AuthorizedConnection | null =
		connectionId === undefined
			? null
			: {
					connectionId,
					grantingTenantId: proposal.grantingTenantId,
					receivingTenantId: proposal.receivingTenantId,
					channelId: proposal.channelId,
					channelName: proposal.channelName,
					permission: proposal.permission,
					clippedByUserId: requireString(item, "clipped_by_user_id", "connection"),
					createdAt: new Date(requireString(item, "created_at", "connection")),
				};
	return {
		proposal,
		status: (item.status?.S ?? null) as ConnectionProposalStatus | null,
		escalationTargetUserId: item.escalation_target_user_id?.S ?? null,
		authorized,
	};
}
