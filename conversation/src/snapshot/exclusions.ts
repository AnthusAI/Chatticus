/**
 * Directory names the snapshot pack never includes, at any depth. They are rebuilt by a package manager or a build, so
 * carrying them would make every publish large and every restore slow. The list is a constant of the image, not a setting.
 */
export const PACK_EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
	"node_modules",
	".next",
	"dist",
	"build",
	"target",
	".venv",
	"__pycache__",
	".cache",
]);

/** The largest single file, in bytes, the pack carries; a larger file is left out and reported as skipped. */
export const PACK_MAX_FILE_BYTES = 50 * 1024 * 1024;
