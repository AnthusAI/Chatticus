"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { CostsController } from "@/lib/costs-controller";
import { CostsPanelView, type CostsHandlers, type CostsLabels } from "./CostsPanelView";

type Props = {
  controller: CostsController;
  labels: CostsLabels;
  /** True while the Costs tab is the selected inspector tab. */
  active: boolean;
};

/**
 * The Costs tab of the inspector. The controller holds the behavior and is shared with the conversation header chip
 * and the message markers; this component tells it when the tab is showing and renders its snapshot.
 */
export function CostsPanel({ controller, labels, active }: Props) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => {
    controller.setActive(active);
    return () => controller.setActive(false);
  }, [controller, active]);

  const handlers = useMemo<CostsHandlers>(
    () => ({
      onSetScope: (scope) => controller.setScope(scope),
      onPreviousMonth: () => void controller.previousMonth(),
      onNextMonth: () => void controller.nextMonth(),
      onRetry: () => void controller.retry(),
      onLoadMoreTurns: () => void controller.loadMoreTurns(),
      onLoadMoreGroups: (kind) => void controller.loadMoreGroups(kind),
      onOpenTurn: (turnId) => void controller.openTurn(turnId),
      onCloseDrilldown: () => controller.closeDrilldown(),
      onCloseMessageFocus: () => controller.closeMessageFocus(),
      onExport: (grain) => void controller.exportCosts(grain),
    }),
    [controller],
  );

  return <CostsPanelView snapshot={snapshot} labels={labels} handlers={handlers} />;
}
