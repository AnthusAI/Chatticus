const FALLBACK_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * The environment a model-chosen command gets: a search path, a home inside the workspace, a locale and a terminal type.
 * Nothing else of the owner's environment (its model key, its cloud credentials) is passed on. The file helper is started
 * with the same environment, because it runs as the same unprivileged user.
 *
 * @param home The command's home directory.
 * @param source The environment the search path is taken from.
 * @returns The four variables.
 */
export function scrubbedShellEnvironment(home: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const path = source["PATH"];
	return { PATH: path === undefined || path === "" ? FALLBACK_PATH : path, HOME: home, LANG: "C.UTF-8", TERM: "dumb" };
}
