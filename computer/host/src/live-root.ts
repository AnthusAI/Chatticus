const DEFAULT_LIVE_ROOT = "/var/lib/chatticus/computer";

/** The live-disk root of the computer from the environment, shared by the owner and the host executors. */
export function liveRootFromEnvironment(): string {
	return (process.env["CHATTICUS_LIVE_ROOT"] ?? DEFAULT_LIVE_ROOT).replace(/\/+$/, "");
}
