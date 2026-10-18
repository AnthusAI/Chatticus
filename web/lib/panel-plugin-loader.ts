import { parsePanelPluginManifest, type PanelPluginManifest } from "./panel-plugin-manifest";

export type PanelPluginModuleImporter = (entry: string) => Promise<unknown>;

export type PanelPluginLoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "failed"; message: string };

export type PanelPluginElementRegistry = {
  get: (tag: string) => unknown;
  whenDefined: (tag: string) => Promise<unknown>;
};

export type PanelPluginLoader = {
  load: (manifest: PanelPluginManifest) => Promise<PanelPluginLoadState>;
};

const SECONDS_TO_WAIT_FOR_ELEMENT_DEFINITION = 10;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The plugin failed to load.";
}

async function waitForElementDefinition(elements: PanelPluginElementRegistry, tag: string, secondsToWait: number): Promise<void> {
  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timerHandle = setTimeout(() => reject(new Error(`The plugin never defined <${tag}>.`)), secondsToWait * 1000);
  });
  try {
    await Promise.race([elements.whenDefined(tag), timeout]);
  } finally {
    clearTimeout(timerHandle);
  }
}

export function createPanelPluginLoader(dependencies: {
  importModule: PanelPluginModuleImporter;
  elements: PanelPluginElementRegistry;
  secondsToWaitForElementDefinition?: number;
}): PanelPluginLoader {
  const loads = new Map<string, Promise<PanelPluginLoadState>>();
  const secondsToWait = dependencies.secondsToWaitForElementDefinition ?? SECONDS_TO_WAIT_FOR_ELEMENT_DEFINITION;

  const loadFresh = async (manifest: PanelPluginManifest): Promise<PanelPluginLoadState> => {
    if (manifest.isolation === "iframe") {
      return { status: "failed", message: "Plugins that run in an iframe are not supported yet." };
    }
    try {
      if (manifest.entry !== null) await dependencies.importModule(manifest.entry);
      if (dependencies.elements.get(manifest.elements.panel) === undefined) {
        await waitForElementDefinition(dependencies.elements, manifest.elements.panel, secondsToWait);
      }
      return { status: "ready" };
    } catch (error) {
      return { status: "failed", message: messageOf(error) };
    }
  };

  return {
    load(manifest) {
      const loadKey = `${manifest.id}@${manifest.version}@${manifest.entry ?? "core"}`;
      const existing = loads.get(loadKey);
      if (existing) return existing;
      const started = loadFresh(manifest).then((state) => {
        if (state.status === "failed") loads.delete(loadKey);
        return state;
      });
      loads.set(loadKey, started);
      return started;
    },
  };
}

export async function fetchPanelPluginManifests(
  manifestUrls: readonly string[],
  fetchJson: (url: string) => Promise<unknown>,
): Promise<{ manifests: PanelPluginManifest[]; problems: string[] }> {
  const manifests: PanelPluginManifest[] = [];
  const problems: string[] = [];
  for (const manifestUrl of manifestUrls) {
    try {
      const parsed = parsePanelPluginManifest(await fetchJson(manifestUrl));
      if (parsed.ok) manifests.push(parsed.manifest);
      else problems.push(`${manifestUrl}: ${parsed.problems.join(" ")}`);
    } catch (error) {
      problems.push(`${manifestUrl}: ${messageOf(error)}`);
    }
  }
  return { manifests, problems };
}
