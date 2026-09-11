export const MODEL_SELECTOR_LABEL = "Model";

const STORAGE_KEY = "chatticus.composer.model_id";

export function rememberedModelId(availableIds: string[], fallback: string | null): string {
  if (typeof window === "undefined") {
    return fallback ?? availableIds[0] ?? "";
  }
  const remembered = window.sessionStorage.getItem(STORAGE_KEY);
  if (remembered && availableIds.includes(remembered)) {
    return remembered;
  }
  return fallback && availableIds.includes(fallback) ? fallback : (availableIds[0] ?? "");
}

export function rememberModelId(modelId: string): void {
  if (typeof window === "undefined" || !modelId) {
    return;
  }
  window.sessionStorage.setItem(STORAGE_KEY, modelId);
}
