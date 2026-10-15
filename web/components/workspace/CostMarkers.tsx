"use client";

import { createContext, useContext, type FC } from "react";
import { CircleDollarSign } from "lucide-react";

import { describeFigure, markerText, type MessageCostMarker } from "@/lib/costs";
import type { ChannelCosts, Phase } from "@/lib/costs-controller";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt";

/**
 * The conversation header chip: what the open conversation has cost in all. A figure that leaves out a call with no
 * price says `at least` and `incomplete`; the chip shows nothing while the cost is loading, failed, or zero.
 */
export const ChannelCostChip: FC<{
  phase: Phase<ChannelCosts>;
  onOpen: () => void;
}> = ({ phase, onOpen }) => {
  if (phase.status !== "ready" || phase.value.totals.rows === 0) return null;
  const figure = describeFigure(phase.value.totals);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="channel-cost-chip"
      aria-label={`Conversation cost ${figure.text}${figure.incompleteLabel ? `, ${figure.incompleteLabel}` : ""}. Open the Costs tab`}
      className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-surface-raised px-3 font-mono text-[0.68rem] hover:bg-surface-high ${FOCUS}`}
    >
      <CircleDollarSign size={14} aria-hidden="true" />
      <span>{figure.text}</span>
      {figure.incompleteLabel ? <span className="font-bold text-clay">incomplete</span> : null}
    </button>
  );
};

/** What the thread needs to put a cost marker under a message. */
export type MessageCostContextValue = {
  markers: ReadonlyMap<number, MessageCostMarker[]>;
  onOpen: (seq: number) => void;
};

/** Supplies the markers of the open conversation to the messages of its thread. */
export const MessageCostContext = createContext<MessageCostContextValue | null>(null);

/** The cost of one message: what it triggered, or what it took to write; opens the model calls behind it. */
export const MessageCostMarkerView: FC<{
  seq: number;
  markers: readonly MessageCostMarker[];
  onOpen: (seq: number) => void;
}> = ({ seq, markers, onOpen }) => (
  <span className="mt-1 flex flex-wrap items-center gap-x-2" data-testid="message-cost-marker">
    {markers.map((marker) => (
      <button
        key={marker.side}
        type="button"
        onClick={() => onOpen(seq)}
        aria-label={`${markerText(marker)}${marker.figure.incompleteLabel ? `, ${marker.figure.incompleteLabel}` : ""}. Show the model calls`}
        className={`inline-flex min-h-8 items-center gap-1 rounded-full font-mono text-[0.58rem] text-surface-foreground/55 hover:text-surface-foreground ${FOCUS}`}
      >
        <span>{markerText(marker)}</span>
        {marker.figure.incompleteLabel ? <span className="font-bold text-clay">incomplete</span> : null}
      </button>
    ))}
  </span>
);

/** The marker under a message in the thread, or nothing when the message has no recorded cost. */
export const MessageCostSlot: FC<{ seq: number | undefined }> = ({ seq }) => {
  const context = useContext(MessageCostContext);
  if (!context || seq === undefined) return null;
  const markers = context.markers.get(seq);
  if (!markers || markers.length === 0) return null;
  return <MessageCostMarkerView seq={seq} markers={markers} onOpen={context.onOpen} />;
};
