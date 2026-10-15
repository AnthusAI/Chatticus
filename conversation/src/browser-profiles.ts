import { join, resolve } from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";

export const WORKSPACE_DIRNAME = "workspace";
export const BROWSER_PROFILES_DIRNAME = "browser-profiles";
export const LEGACY_BROWSER_PROFILE_DIRNAME = "browser-profile";
export const UNTRUSTED_PARTITION = "untrusted";
export const PRIVILEGED_PARTITION_PREFIX = "privileged:";
const LEGACY_PRIVILEGED_DIRNAME = "_legacy";
const SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Return the Chromium user-data directory for one storage partition.
 */
export function browserProfileDir(liveRoot: string, storagePartition: string): string {
	const root = resolve(liveRoot);
	const partition = (storagePartition || "").trim() || UNTRUSTED_PARTITION;

	if (partition === UNTRUSTED_PARTITION) {
		return join(root, BROWSER_PROFILES_DIRNAME, UNTRUSTED_PARTITION);
	}

	if (partition.startsWith(PRIVILEGED_PARTITION_PREFIX)) {
		const service = partition.slice(PRIVILEGED_PARTITION_PREFIX.length);
		if (!service || !SERVICE_NAME_RE.test(service)) {
			throw new Error(`invalid privileged storage partition ${JSON.stringify(storagePartition)}`);
		}
		return join(root, BROWSER_PROFILES_DIRNAME, "privileged", service);
	}

	throw new Error(`unknown storage partition ${JSON.stringify(storagePartition)}`);
}

/**
 * Move a legacy singular browser profile into the partitioned tree once.
 */
export function migrateLegacyBrowserProfile(liveRoot: string): void {
	const root = resolve(liveRoot);
	const legacy = join(root, LEGACY_BROWSER_PROFILE_DIRNAME);
	const profilesRoot = join(root, BROWSER_PROFILES_DIRNAME);

	if (!existsSync(legacy) || existsSync(profilesRoot)) {
		return;
	}

	const target = join(profilesRoot, "privileged", LEGACY_PRIVILEGED_DIRNAME);
	mkdirSync(join(profilesRoot, "privileged"), { recursive: true });
	renameSync(legacy, target);
}

/**
 * Create partitioned browser profile directories on one host.
 */
export function ensureBrowserProfilesLayout(liveRoot: string): void {
	const root = resolve(liveRoot);
	mkdirSync(root, { recursive: true });
	migrateLegacyBrowserProfile(root);
	mkdirSync(join(root, BROWSER_PROFILES_DIRNAME, UNTRUSTED_PARTITION), { recursive: true });
	mkdirSync(join(root, BROWSER_PROFILES_DIRNAME, "privileged"), { recursive: true });
}
