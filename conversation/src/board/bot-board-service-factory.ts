import { BotBoardService, type BoardMembershipReader } from "./bot-board-service.ts";
import { createSigV4SignedFetch, kanbusApiUrlFrom, type BoardServiceCredentials } from "./kanbus-board-client.ts";

/**
 * Build the board service for a Lambda from its environment: the whole board capability is active only where
 * `CHATTICUS_KANBUS_API_URL` is set, and requests are signed with the function role's own credentials.
 *
 * @param environment The process environment.
 * @param options The role's credential provider and the membership store the owner rules read.
 * @returns The service, or null when the board capability is not rolled out in this environment.
 * @throws Error If the URL is set but `AWS_REGION` is not.
 */
export function botBoardServiceFromEnvironment(
	environment: Record<string, string | undefined>,
	options: { readonly credentials: () => Promise<BoardServiceCredentials>; readonly memberships: BoardMembershipReader },
): BotBoardService | null {
	const baseUrl = kanbusApiUrlFrom(environment);
	if (baseUrl === null) return null;
	const region = environment["AWS_REGION"];
	if (region === undefined || region === "") throw new Error("The environment variable AWS_REGION is required when CHATTICUS_KANBUS_API_URL is set.");
	return new BotBoardService({
		baseUrl,
		fetch: createSigV4SignedFetch({ credentials: options.credentials, region }),
		memberships: options.memberships,
	});
}
