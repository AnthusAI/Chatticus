/**
 * Browser profile directories of the host disk. The conversation workspace owns these rules because the snapshot pack
 * and the host disk use them too; the host executors import them from here.
 */
export {
	BROWSER_PROFILES_DIRNAME,
	LEGACY_BROWSER_PROFILE_DIRNAME,
	PRIVILEGED_PARTITION_PREFIX,
	UNTRUSTED_PARTITION,
	WORKSPACE_DIRNAME,
	browserProfileDir,
	ensureBrowserProfilesLayout,
	migrateLegacyBrowserProfile,
} from "../../../conversation/src/browser-profiles.ts";
