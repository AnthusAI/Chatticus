"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { listBots } from "@/lib/api";
import { BoardWorkspaceController, type BoardSelectionStore } from "@/lib/board-workspace-controller";
import { botBoardsApiFor } from "@/lib/bot-boards-api";
import { computerFilesApiFor } from "@/lib/computer-files-api";
import type { ActiveOrg } from "@/lib/membership-state";
import "@/styles/kanbus-board.css";
import { KanbusBoardPanelFrame } from "./KanbusBoardPanelFrame";

type Props = {
  org: ActiveOrg;
  /** True while the Board tab is the selected panel tab. */
  active: boolean;
  /** The workspace color scheme; the board component keys its dark palette off it. */
  theme: "light" | "dark";
};

function browserSelectionStore(org: ActiveOrg): BoardSelectionStore {
  const key = `chatticus.board.selection.${org.tenantId}.${org.userId}`;
  return {
    read: () => window.localStorage.getItem(key),
    write: (value) => window.localStorage.setItem(key, value),
  };
}

/** The Board tab. The controller reads the project board from the workspace and the bot boards from the front door; this component tells it when the tab is showing. */
export function KanbusBoardPanel({ org, active, theme }: Props) {
  const [controller] = useState(
    () =>
      new BoardWorkspaceController({
        filesApi: computerFilesApiFor(org),
        botBoardsApi: botBoardsApiFor(org),
        listBots: () => listBots(org),
        selectionStore: browserSelectionStore(org),
      }),
  );
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const handlers = useMemo(
    () => ({
      onRefresh: () => void controller.refresh(),
      onSelect: controller.select.bind(controller),
      onTogglePicker: () => (controller.getSnapshot().picker.open ? controller.closePicker() : controller.openPicker()),
    }),
    [controller],
  );

  useEffect(() => {
    controller.setActive(active);
  }, [controller, active]);

  useEffect(() => () => controller.dispose(), [controller]);

  return <KanbusBoardPanelFrame snapshot={snapshot} handlers={handlers} theme={theme} />;
}
