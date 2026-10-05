/**
 * Codecs for Organization items.
 * Ported from python/src/chatticus/messaging/store.py lines 3057-3108.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";

export interface Organization {
	tenantId: string;
	name: string;
	status: string;
	ownerUserId: string;
	createdAt: Date;
	awsAccountId?: string;
	awsCrossAccountRole?: string;
	awsExternalId?: string;
	awsSetupPath?: string;
	setupFeeCents?: number;
	assistedSetupSession?: boolean;
	monthlyAwsSpendCeilingUsd?: string;
}

export type Item = Record<string, AttributeValue>;

/**
 * Encode an Organization to a DynamoDB item.
 * @param value Organization to encode.
 * @returns DynamoDB item.
 */
export function encode(value: Organization): Item {
	const item: Item = {
		pk: { S: `${value.tenantId}#org` },
		sk: { S: "meta" },
		tenant_id: { S: value.tenantId },
		name: { S: value.name },
		status: { S: value.status },
		owner_user_id: { S: value.ownerUserId },
		created_at: { S: value.createdAt.toISOString() },
	};

	if (value.awsAccountId !== undefined) {
		item.aws_account_id = { S: value.awsAccountId };
	}
	if (value.awsCrossAccountRole !== undefined) {
		item.aws_cross_account_role = { S: value.awsCrossAccountRole };
	}
	if (value.awsExternalId !== undefined) {
		item.aws_external_id = { S: value.awsExternalId };
	}
	if (value.awsSetupPath !== undefined) {
		item.aws_setup_path = { S: value.awsSetupPath };
	}
	if (value.setupFeeCents !== undefined) {
		item.setup_fee_cents = { N: String(value.setupFeeCents) };
	}
	if (value.assistedSetupSession) {
		item.assisted_setup_session = { BOOL: true };
	}
	if (value.monthlyAwsSpendCeilingUsd !== undefined) {
		item.monthly_aws_spend_ceiling_usd = { N: value.monthlyAwsSpendCeilingUsd };
	}

	return item;
}

/**
 * Decode an Organization from a DynamoDB item.
 * @param item DynamoDB item.
 * @returns Decoded Organization.
 * @throws Error if required attributes are missing.
 */
export function decode(item: Item): Organization {
	const tenantId = item.tenant_id?.S;
	if (!tenantId) {
		throw new Error("malformed organization item: tenant_id");
	}

	const name = item.name?.S;
	if (!name) {
		throw new Error("malformed organization item: name");
	}

	const status = item.status?.S;
	if (!status) {
		throw new Error("malformed organization item: status");
	}

	const ownerUserId = item.owner_user_id?.S;
	if (!ownerUserId) {
		throw new Error("malformed organization item: owner_user_id");
	}

	const createdAtStr = item.created_at?.S;
	if (!createdAtStr) {
		throw new Error("malformed organization item: created_at");
	}

	const setupFeeCents = item.setup_fee_cents?.N;
	const monthlyAwsSpendCeilingUsd = item.monthly_aws_spend_ceiling_usd?.N;

	return {
		tenantId,
		name,
		status,
		ownerUserId,
		createdAt: new Date(createdAtStr),
		awsAccountId: item.aws_account_id?.S,
		awsCrossAccountRole: item.aws_cross_account_role?.S,
		awsExternalId: item.aws_external_id?.S,
		awsSetupPath: item.aws_setup_path?.S,
		setupFeeCents: setupFeeCents ? Number(setupFeeCents) : undefined,
		assistedSetupSession: item.assisted_setup_session?.BOOL ?? false,
		monthlyAwsSpendCeilingUsd,
	};
}
