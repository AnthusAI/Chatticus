"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { computerFilesApiFor } from "@/lib/computer-files-api";
import type { ActiveOrg } from "@/lib/membership-state";
import { KanbusBoardController } from "@/lib/kanbus-board-controller";
import "@/styles/kanbus-board.css";
import { KanbusBoardPanelFrame } from "./KanbusBoardPanelFrame";

type Props = {
  org: ActiveOrg;
  /** True while the Board tab is the selected panel tab. */
  active: boolean;
  /** The workspace color scheme; the board component keys its dark palette off it. */
  theme: "light" | "dark";
};

/** The Board tab. The controller reads the workspace's Kanbus project; this component tells it when the tab is showing. */
export function KanbusBoardPanel({ org, active, theme }: Props) {
  const [controller] = useState(() => new KanbusBoardController({ api: computerFilesApiFor(org) }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const handlers = useMemo(() => ({ onRefresh: () => void controller.refresh() }), [controller]);

  useEffect(() => {
    controller.setActive(active);
    return () => controller.setActive(false);
  }, [controller, active]);

  useEffect(() => () => controller.dispose(), [controller]);

  return <KanbusBoardPanelFrame snapshot={snapshot} handlers={handlers} theme={theme} />;
}
