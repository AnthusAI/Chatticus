export type PanelPluginElementSize = "card" | "split" | "full";

export type PanelPluginIsolation = "inline" | "iframe";

export type PanelPluginManifest = {
  id: string;
  name: string;
  icon: string | null;
  version: string;
  entry: string | null;
  isolation: PanelPluginIsolation;
  elements: { panel: string; card: string | null };
  sizes: readonly PanelPluginElementSize[];
  handles: readonly string[];
  permissions: readonly string[];
};

export type PanelPluginManifestParseResult =
  | { ok: true; manifest: PanelPluginManifest }
  | { ok: false; problems: readonly string[] };

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CUSTOM_ELEMENT_TAG_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const RESERVED_ELEMENT_TAGS: ReadonlySet<string> = new Set([
  "annotation-xml",
  "color-profile",
  "font-face",
  "font-face-src",
  "font-face-uri",
  "font-face-format",
  "font-face-name",
  "missing-glyph",
]);
const SEMANTIC_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const KNOWN_SIZES: ReadonlySet<string> = new Set(["card", "split", "full"]);
const KNOWN_ISOLATIONS: ReadonlySet<string> = new Set(["inline", "iframe"]);
const OBJECT_TYPE_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

export function isValidPanelPluginEntryUrl(entry: string): boolean {
  if (entry.startsWith("/") && !entry.startsWith("//")) return !entry.includes("..");
  try {
    const url = new URL(entry);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function parsePanelPluginManifest(raw: unknown): PanelPluginManifestParseResult {
  if (!isRecord(raw)) return { ok: false, problems: ["The manifest must be a JSON object."] };
  const problems: string[] = [];

  const id = raw.id;
  if (typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)) problems.push("id must be lowercase words joined by hyphens.");

  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") problems.push("name must be a non-empty string.");

  const version = raw.version;
  if (typeof version !== "string" || !SEMANTIC_VERSION_PATTERN.test(version)) problems.push("version must be a semantic version such as 1.2.3.");

  const icon = raw.icon === undefined || raw.icon === null ? null : raw.icon;
  if (icon !== null && typeof icon !== "string") problems.push("icon must be a string when present.");

  const entry = raw.entry === undefined || raw.entry === null ? null : raw.entry;
  if (entry !== null && (typeof entry !== "string" || !isValidPanelPluginEntryUrl(entry))) {
    problems.push("entry must be an https URL or a same-origin path.");
  }

  const isolation = raw.isolation === undefined ? "inline" : raw.isolation;
  if (typeof isolation !== "string" || !KNOWN_ISOLATIONS.has(isolation)) problems.push("isolation must be inline or iframe.");

  const elements = raw.elements;
  let panelTag: string | null = null;
  let cardTag: string | null = null;
  if (!isRecord(elements)) {
    problems.push("elements must name the panel element.");
  } else {
    const validTag = (tag: unknown): tag is string =>
      typeof tag === "string" && CUSTOM_ELEMENT_TAG_PATTERN.test(tag) && !RESERVED_ELEMENT_TAGS.has(tag);
    if (validTag(elements.panel)) panelTag = elements.panel;
    else problems.push("elements.panel must be a custom element tag name containing a hyphen.");
    if (elements.card !== undefined && elements.card !== null) {
      if (validTag(elements.card)) cardTag = elements.card;
      else problems.push("elements.card must be a custom element tag name containing a hyphen.");
    }
  }

  const sizes = stringList(raw.sizes);
  if (sizes === null || sizes.length === 0 || !sizes.every((size) => KNOWN_SIZES.has(size))) {
    problems.push("sizes must list one or more of card, split and full.");
  } else if (sizes.includes("card") && cardTag === null) {
    problems.push("a plugin that supports the card size must name elements.card.");
  }

  const handles = raw.handles === undefined ? [] : stringList(raw.handles);
  if (handles === null || !handles.every((type) => OBJECT_TYPE_PATTERN.test(type))) {
    problems.push("handles must list object types such as kanbus.board.");
  }

  const permissions = raw.permissions === undefined ? [] : stringList(raw.permissions);
  if (permissions === null || !permissions.every((permission) => PERMISSION_PATTERN.test(permission))) {
    problems.push("permissions must list dotted permission names such as workspace.files.read.");
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    manifest: {
      id: id as string,
      name: (name as string).trim(),
      icon: icon as string | null,
      version: version as string,
      entry: entry as string | null,
      isolation: isolation as PanelPluginIsolation,
      elements: { panel: panelTag as string, card: cardTag },
      sizes: sizes as PanelPluginElementSize[],
      handles: handles as string[],
      permissions: permissions as string[],
    },
  };
}
