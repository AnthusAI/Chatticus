export const TURN_GRANT_FORM_TITLE = "Authorize this turn";

export const CONVERSATION_PRESET_TOOLS = ["read_workspace", "write_workspace"] as const;

export type TurnGrantPayload = {
  tools: string[];
  origins: string[];
  recipients: string[];
  file_scopes: string[];
  egress_classes: string[];
  ingest_classes: string[];
};

export type TurnGrantFormState = {
  browse: boolean;
  readWorkspace: boolean;
  writeWorkspace: boolean;
  runTerminal: boolean;
  origins: string;
  fileScopes: string;
};

export const DEFAULT_TURN_GRANT_FORM: TurnGrantFormState = {
  browse: false,
  readWorkspace: false,
  writeWorkspace: false,
  runTerminal: false,
  origins: "",
  fileScopes: "/workspace",
};

function splitCommaSeparated(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function grantTableToPayload(table: Record<string, string>): TurnGrantPayload {
  const splitField = (field: string): string[] => splitCommaSeparated(table[field] ?? "");

  return {
    tools: splitField("tools"),
    recipients: splitField("recipients"),
    origins: splitField("origins"),
    file_scopes: splitField("file_scopes"),
    egress_classes: splitField("egress_classes"),
    ingest_classes: splitField("ingest_classes"),
  };
}

export function buildTurnGrantPayload(form: TurnGrantFormState): TurnGrantPayload | null {
  const tools: string[] = [];
  if (form.browse) {
    tools.push("browse");
  }
  if (form.readWorkspace) {
    tools.push("read_workspace");
  }
  if (form.writeWorkspace) {
    tools.push("write_workspace");
  }
  if (form.runTerminal) {
    tools.push("run_terminal");
  }
  if (tools.length === 0) {
    return null;
  }

  const origins = form.browse ? splitCommaSeparated(form.origins) : [];
  if (form.browse && origins.length === 0) {
    return null;
  }

  const fileScopes = splitCommaSeparated(form.fileScopes);
  const resolvedFileScopes =
    fileScopes.length > 0
      ? fileScopes
      : tools.some((tool) => tool === "read_workspace" || tool === "write_workspace")
        ? ["/workspace"]
        : form.browse
          ? ["/workspace"]
          : [];

  return {
    tools,
    origins,
    recipients: [],
    file_scopes: resolvedFileScopes,
    egress_classes: form.browse ? ["approved_origin_fetch"] : [],
    ingest_classes: [],
  };
}

export function turnGrantConfirmationText(tools: readonly string[]): string {
  const sorted = [...tools].sort();
  return `Turn grant updated: ${sorted.join(", ")}.`;
}

export function isTurnGrantPanelVisible(
  turnId: string | null,
  turnStatus: "active" | "completed" | "failed" | "reconciling" | null,
): boolean {
  return turnId !== null && turnStatus === "active";
}
