"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { computerFilesApiFor } from "@/lib/computer-files-api";
import { ComputerFilesController } from "@/lib/computer-files-controller";
import { draftIsChanged } from "@/lib/computer-files-edit";
import type { ActiveOrg } from "@/lib/membership-state";
import type { TouchedFile } from "@/lib/touched-files";
import { ComputerFilesPanelView, type PanelHandlers } from "./ComputerFilesPanelView";

type Props = {
  org: ActiveOrg;
  touched: readonly TouchedFile[];
  role: "owner" | "member";
  /** True while the Files tab is the selected inspector tab. */
  active: boolean;
};

/**
 * The Files panel of the organization's computer. The controller holds the
 * behavior; this component feeds it the tab and page visibility, the bot's
 * touched files and the browser's clipboard, and renders its snapshot.
 */
export function ComputerFilesPanel({ org, touched, role, active }: Props) {
  const [controller] = useState(() => new ComputerFilesController({ api: computerFilesApiFor(org), role }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    const apply = () => controller.setActive(active && document.visibilityState === "visible");
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => {
      document.removeEventListener("visibilitychange", apply);
      controller.setActive(false);
    };
  }, [controller, active]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      const edit = controller.getSnapshot().edit;
      if (edit && draftIsChanged(edit)) event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [controller]);

  useEffect(() => {
    controller.noteTouched(touched);
  }, [controller, touched]);

  useEffect(() => {
    setCopied(false);
  }, [snapshot.openFile]);

  const writeClipboard = useCallback((text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, []);

  const handlers = useMemo<PanelHandlers>(
    () => ({
      onRefresh: () => controller.refresh(),
      onOpenDirectory: (path) => controller.openDirectory(path),
      onOpenFile: (path) => controller.openFile(path),
      onBack: () => controller.backToFolder(),
      onLoadMore: () => void controller.loadMore(),
      onCopy: () => writeClipboard(controller.currentText()),
      onEdit: () => controller.beginEdit(),
      onDraft: (text) => controller.setDraft(text),
      onSave: () => void controller.save(),
      onRetrySave: () => void controller.retrySave(),
      onReloadUnknown: () => void controller.reloadAfterUnknown(),
      onShowTheirs: () => void controller.showTheirVersion(),
      onOverwrite: () => void controller.overwriteWithMine(),
      onUseTheirs: () => controller.useTheirs(),
      onCopyMine: () => writeClipboard(controller.mineText() ?? ""),
      onRequestReveal: () => controller.requestReveal(),
      onHide: () => controller.hide(),
      onAnswer: (confirmed) => void controller.answerConfirm(confirmed),
      onNewFile: (name) => void controller.createFile(name),
      onNewFolder: (name) => void controller.makeFolder(name),
      onRename: (path, newName) => void controller.renameEntry(path, newName),
      onDelete: (path, directory) => void controller.requestDelete(path, directory),
      onOpenPending: () => void controller.setPendingOpen(true),
      onClosePending: () => void controller.setPendingOpen(false),
      onDiscardPending: (path) => controller.requestDiscardPending(path),
    }),
    [controller, writeClipboard],
  );

  return <ComputerFilesPanelView snapshot={snapshot} touched={touched} copied={copied} handlers={handlers} />;
}
