/**
 * Customer-account computer image presence and operator publish helpers.
 * Ported from python/src/chatticus/customer_computer_image.py lines 1-167.
 */

import { OrganizationComputerProvisioningError } from "../http/errors.ts";
import type { Organization } from "../domain/organizations.ts";
import {
	AwsApiError,
	type AssumeRolePort,
	type CloudFormationPort,
	type EcrPort,
	type SessionCredentials,
} from "./aws-ports.ts";
import { COMPUTER_REPOSITORY_URI_OUTPUT, describeCustomerComputersStack, stackOutputsFromDescribeStacks } from "./customer-stack.ts";
import { attemptCrossAccountAssumeRole } from "./provisioning.ts";

export const DEV_IMAGE_TAG = "dev";

/** Return the repository name segment from one ECR repository URI. */
export function repositoryNameFromUri(repositoryUri: string): string {
	const segments = repositoryUri.replace(/\/+$/, "").split("/");
	const name = (segments[segments.length - 1] ?? "").trim();
	if (name === "") {
		throw new Error(`Could not parse repository name from URI ${JSON.stringify(repositoryUri)}.`);
	}
	return name;
}

/** Return whether `error` means the requested image tag does not exist. */
export function isImageNotFoundError(error: unknown): boolean {
	return error instanceof AwsApiError && (error.code === "ImageNotFoundException" || error.code === "RepositoryNotFoundException");
}

/** Return whether `repositoryName` has an image tagged `tag`. */
export async function customerImageTagExists(
	ecr: EcrPort,
	options: { repositoryName: string; tag?: string },
): Promise<boolean> {
	const tag = options.tag ?? DEV_IMAGE_TAG;
	let response: { imageDetails?: unknown[] };
	try {
		response = await ecr.describeImages({ repositoryName: options.repositoryName, imageIds: [{ imageTag: tag }] });
	} catch (error) {
		if (isImageNotFoundError(error)) {
			return false;
		}
		throw error;
	}
	return (response.imageDetails ?? []).length > 0;
}

/** Refuse when the customer repository does not yet have `tag`; return the image URI otherwise. */
export async function requireCustomerComputerImage(
	ecr: EcrPort,
	options: { repositoryUri: string; tag?: string },
): Promise<string> {
	const tag = options.tag ?? DEV_IMAGE_TAG;
	const repositoryName = repositoryNameFromUri(options.repositoryUri);
	if (await customerImageTagExists(ecr, { repositoryName, tag })) {
		return `${options.repositoryUri}:${tag}`;
	}
	throw new OrganizationComputerProvisioningError(
		`Customer computer image tag ${JSON.stringify(tag)} is missing from repository ${JSON.stringify(repositoryName)}; ` +
			"publish :dev to the organization AWS home before starting a host.",
	);
}

/** Copy one tagged image from Anthus ECR into a customer repository. */
export async function publishDevImageFromAnthus(
	anthusEcr: EcrPort,
	customerEcr: EcrPort,
	options: { anthusRepositoryName: string; customerRepositoryName: string; tag?: string },
): Promise<string> {
	const tag = options.tag ?? DEV_IMAGE_TAG;
	const response = await anthusEcr.batchGetImage({
		repositoryName: options.anthusRepositoryName,
		imageIds: [{ imageTag: tag }],
	});
	const failures = response.failures ?? [];
	if (failures.length > 0) {
		throw new OrganizationComputerProvisioningError(
			`Anthus repository ${JSON.stringify(options.anthusRepositoryName)} has no tag ${JSON.stringify(tag)}; ` +
				`batch_get_image failures=${JSON.stringify(failures)}.`,
		);
	}
	const images = response.images ?? [];
	if (images.length === 0) {
		throw new OrganizationComputerProvisioningError(
			`Anthus repository ${JSON.stringify(options.anthusRepositoryName)} has no tag ${JSON.stringify(tag)}.`,
		);
	}
	const imageManifest = images[0]?.imageManifest;
	if (typeof imageManifest !== "string" || imageManifest === "") {
		throw new OrganizationComputerProvisioningError(
			`Anthus repository ${JSON.stringify(options.anthusRepositoryName)} returned no manifest for tag ${JSON.stringify(tag)}.`,
		);
	}
	await customerEcr.putImage({
		repositoryName: options.customerRepositoryName,
		imageManifest,
		imageTag: tag,
	});
	return tag;
}

/**
 * Publish the Anthus dev computer image into one organization's customer ECR repository.
 *
 * The push runs only through temporary credentials assumed from the organization's own cross-account role, and the
 * returned image URI is the one now present in the customer repository.
 */
export async function publishCustomerComputerImage(
	organization: Organization,
	options: {
		assumeRole: AssumeRolePort;
		anthusEcr: EcrPort;
		anthusRepositoryName: string;
		cloudformationClientFactory: (credentials: SessionCredentials) => CloudFormationPort;
		ecrClientFactory: (credentials: SessionCredentials) => EcrPort;
	},
): Promise<string> {
	const outcome = await attemptCrossAccountAssumeRole(organization, { assumeRole: options.assumeRole });
	if (outcome.refused || outcome.session === null) {
		throw new OrganizationComputerProvisioningError(
			`Organization ${JSON.stringify(organization.tenantId)} cross-account role refused AssumeRole for the image publish.`,
		);
	}
	const credentials: SessionCredentials = {
		accessKeyId: outcome.session.accessKeyId,
		secretAccessKey: outcome.session.secretAccessKey,
		sessionToken: outcome.session.sessionToken,
	};
	const stackOutputs = stackOutputsFromDescribeStacks(
		await describeCustomerComputersStack(options.cloudformationClientFactory(credentials)),
	);
	const repositoryUri = (stackOutputs[COMPUTER_REPOSITORY_URI_OUTPUT] ?? "").trim();
	if (repositoryUri === "") {
		throw new OrganizationComputerProvisioningError(
			`The customer computers stack of ${JSON.stringify(organization.tenantId)} has no ${COMPUTER_REPOSITORY_URI_OUTPUT} output.`,
		);
	}
	const customerEcr = options.ecrClientFactory(credentials);
	await publishDevImageFromAnthus(options.anthusEcr, customerEcr, {
		anthusRepositoryName: options.anthusRepositoryName,
		customerRepositoryName: repositoryNameFromUri(repositoryUri),
	});
	return requireCustomerComputerImage(customerEcr, { repositoryUri });
}
