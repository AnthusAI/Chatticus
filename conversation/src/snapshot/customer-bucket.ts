/**
 * Customer organization snapshot bucket naming.
 * Ported from python/src/chatticus/customer_snapshot_bucket.py lines 1-31.
 */

export const BUCKET_NAME_PREFIX = "chatticus-snapshots-";
const MAX_BUCKET_NAME_LENGTH = 63;
const ORGANIZATION_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** The organization id cannot form a valid customer snapshot bucket name. */
export class CustomerSnapshotBucketNameError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CustomerSnapshotBucketNameError";
	}
}

/** Return the customer snapshot bucket name for one organization. */
export function customerSnapshotBucketName(organizationId: string): string {
	const organization = organizationId.trim().toLowerCase();
	if (organization === "") {
		throw new CustomerSnapshotBucketNameError("organization_id must not be empty.");
	}
	if (!ORGANIZATION_ID.test(organization)) {
		throw new CustomerSnapshotBucketNameError(
			`organization_id ${JSON.stringify(organizationId)} is not a valid bucket segment.`,
		);
	}
	const name = `${BUCKET_NAME_PREFIX}${organization}`;
	if (name.length > MAX_BUCKET_NAME_LENGTH) {
		throw new CustomerSnapshotBucketNameError(
			`Snapshot bucket name ${JSON.stringify(name)} exceeds ${MAX_BUCKET_NAME_LENGTH} characters.`,
		);
	}
	return name;
}
