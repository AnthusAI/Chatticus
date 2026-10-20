"use client";

import type { ComponentProps, ReactNode } from "react";
import { Check, Computer as ComputerIcon, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TurnGrantPanel } from "@/components/TurnGrantPanel";
import type { CostsController } from "@/lib/costs-controller";
import type { PanelPluginElementBinding } from "@/lib/panel-plugin-host-api";
import type { ActiveOrg } from "@/lib/membership-state";
import type { TouchedFile } from "@/lib/touched-files";
import type { InspectorModel } from "@/lib/workspace-actions";
import { ComputerFilesPanel } from "../ComputerFilesPanel";
import { CostsPanel } from "../CostsPanel";
import { KanbusBoardPanel } from "../KanbusBoardPanel";
import { defineReactPanelElement } from "./react-panel-element";

export type CorePanelServices = {
  activeOrg: ActiveOrg;
  role: "owner" | "member";
  touchedFiles: readonly TouchedFile[];
  costs: CostsController;
  costLabels: ComponentProps<typeof CostsPanel>["labels"];
  inspector: InspectorModel;
  tasksAreOrganizationWide: boolean;
  turnGrantTurnId: string | null;
};

const FOCUS_RING_CLASS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt";

function servicesOf(binding: PanelPluginElementBinding): CorePanelServices {
  return binding.context.services as CorePanelServices;
}

function ScrollingPanelBody({ children }: { children: ReactNode }) {
  return <div className="h-full min-h-0 space-y-4 overflow-y-auto pb-4">{children}</div>;
}

function ContextPanelElementView(binding: PanelPluginElementBinding) {
  const { activeOrg, inspector, tasksAreOrganizationWide, turnGrantTurnId } = servicesOf(binding);
  return (
    <ScrollingPanelBody>
      <section className="rounded-2xl bg-surface p-4">
        <div className="flex items-center gap-2"><ComputerIcon size={17} aria-hidden="true" /><h3 className="text-sm font-bold">Computer</h3></div>
        {inspector.computer ? (
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
            <dt className="text-surface-foreground/50">State</dt><dd className="font-semibold">{inspector.computer.stateLabel}</dd>
            <dt className="text-surface-foreground/50">Policy</dt><dd className="font-mono">{inspector.computer.policy}</dd>
            <dt className="text-surface-foreground/50">Generation</dt><dd className="font-mono">{inspector.computer.generation}</dd>
            <dt className="text-surface-foreground/50">Identity</dt><dd className="truncate font-mono" title={inspector.computer.identity}>{inspector.computer.identity}</dd>
          </dl>
        ) : <p className="mt-3 text-xs text-surface-foreground/55">Computer status unavailable.</p>}
        {inspector.computerControls.map((control) => <Button key={control} variant="ghost" size="sm">{control}</Button>)}
      </section>
      <section>
        <div className="flex items-center gap-2 px-1"><Check size={17} aria-hidden="true" /><h3 className="text-sm font-bold">{tasksAreOrganizationWide ? "Organization tasks" : "Tasks"}</h3></div>
        {tasksAreOrganizationWide ? <p className="px-1 pt-1 text-xs text-surface-foreground/50">Tasks are organization-wide and are not linked to channels.</p> : null}
        <div className="mt-3 grid gap-2">
          {inspector.tasks.map(({ task, creatorName: creator, updaterName: updater }) => (
            <details key={task.task_id} className="group rounded-2xl bg-surface p-4">
              <summary className={`flex cursor-pointer list-none items-start justify-between gap-3 ${FOCUS_RING_CLASS}`}>
                <span className="text-sm font-semibold leading-5">{task.title}</span>
                <span className="flex shrink-0 items-center gap-1 font-mono text-[0.6rem] uppercase text-surface-foreground/50">{task.status}<ChevronDown size={13} className="transition-transform group-open:rotate-180" aria-hidden="true" /></span>
              </summary>
              <dl className="mt-3 grid gap-2 text-xs text-surface-foreground/65">
                {task.evidence ? <div><dt className="font-semibold text-surface-foreground">Evidence</dt><dd className="mt-0.5 whitespace-pre-wrap">{task.evidence}</dd></div> : null}
                {task.close_reason ? <div><dt className="font-semibold text-surface-foreground">Close reason</dt><dd className="mt-0.5">{task.close_reason}</dd></div> : null}
                {creator || updater ? <div><dt className="font-semibold text-surface-foreground">Bot provenance</dt><dd className="mt-0.5">{creator ? `Created by ${creator}` : ""}{creator && updater ? "; " : ""}{updater ? `updated by ${updater}` : ""}</dd></div> : null}
              </dl>
            </details>
          ))}
          {inspector.tasks.length === 0 ? <p className="rounded-2xl bg-surface p-4 text-xs text-surface-foreground/55">No matching tasks.</p> : null}
        </div>
      </section>
      {turnGrantTurnId !== null ? <TurnGrantPanel activeOrg={activeOrg} turnId={turnGrantTurnId} /> : null}
    </ScrollingPanelBody>
  );
}

function FilesPanelElementView(binding: PanelPluginElementBinding) {
  const { activeOrg, role, touchedFiles } = servicesOf(binding);
  return (
    <ScrollingPanelBody>
      <ComputerFilesPanel org={activeOrg} touched={touchedFiles} role={role} active={binding.context.active} />
    </ScrollingPanelBody>
  );
}

function CostsPanelElementView(binding: PanelPluginElementBinding) {
  const { costs, costLabels } = servicesOf(binding);
  return (
    <ScrollingPanelBody>
      <CostsPanel controller={costs} labels={costLabels} active={binding.context.active} />
    </ScrollingPanelBody>
  );
}

function BoardPanelElementView(binding: PanelPluginElementBinding) {
  const { activeOrg } = servicesOf(binding);
  return <KanbusBoardPanel org={activeOrg} active={binding.context.active} theme={binding.context.theme} />;
}

export function defineCorePanelElements(): void {
  defineReactPanelElement("chatticus-context-panel", ContextPanelElementView);
  defineReactPanelElement("chatticus-files-panel", FilesPanelElementView);
  defineReactPanelElement("chatticus-costs-panel", CostsPanelElementView);
  defineReactPanelElement("chatticus-board-panel", BoardPanelElementView);
}
