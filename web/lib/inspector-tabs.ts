export type InspectorTabId = "context" | "files" | "costs";

export const INSPECTOR_TABS: ReadonlyArray<{ id: InspectorTabId; label: string }> = [
  { id: "context", label: "Context" },
  { id: "files", label: "Files" },
  { id: "costs", label: "Costs" },
];

/** The tab an arrow, Home or End key moves to; null for any other key. */
export function nextInspectorTab(current: InspectorTabId, key: string): InspectorTabId | null {
  const index = INSPECTOR_TABS.findIndex((tab) => tab.id === current);
  const last = INSPECTOR_TABS.length - 1;
  switch (key) {
    case "ArrowRight":
      return INSPECTOR_TABS[index === last ? 0 : index + 1].id;
    case "ArrowLeft":
      return INSPECTOR_TABS[index === 0 ? last : index - 1].id;
    case "Home":
      return INSPECTOR_TABS[0].id;
    case "End":
      return INSPECTOR_TABS[last].id;
    default:
      return null;
  }
}
