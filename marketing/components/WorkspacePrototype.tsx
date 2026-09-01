"use client";

import { useState } from "react";
import { ArrowUpRight, Check, CircleDot, Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { CreativeCharacter } from "@/components/CreativeCharacter";
import type { CreativeMotionState, CreativeRole } from "anthus-vultus";

type Teammate = {
  name: string;
  role: CreativeRole;
  state: CreativeMotionState;
  activity: string;
};

const teammates: Teammate[] = [
  { name: "Marin", role: "Editor", state: "editing", activity: "Reviewing the brief" },
  { name: "Nell", role: "Reporter", state: "gathering", activity: "Finding primary sources" },
  { name: "June", role: "Copy Writer", state: "drafting", activity: "Drafting the opening" },
  { name: "Sol", role: "Illustrator", state: "drawing", activity: "Composing the lead art" },
];

export function WorkspacePrototype() {
  const [activeIndex, setActiveIndex] = useState(0);
  const active = teammates[activeIndex];

  return (
    <div className="workspace-prototype relative mx-auto w-[85%] max-w-[28rem] lg:w-full lg:max-w-[31rem]">
      <div aria-hidden="true" className="prototype-halo prototype-halo-one" />
      <div aria-hidden="true" className="prototype-halo prototype-halo-two" />
      <section
        aria-label="Chatticus workspace preview"
        className="relative overflow-hidden rounded-[2rem] border-2 border-ink bg-[#20231d] p-2 text-paper shadow-[14px_18px_0_rgba(17,19,15,0.18)] sm:p-3"
      >
        <div className="flex items-center justify-between rounded-[1.35rem] border border-paper/15 bg-paper/[0.06] px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-[0.6rem] bg-signal text-ink">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <div>
              <p className="font-mono text-[0.52rem] uppercase tracking-[0.14em] text-paper/55">Chatticus</p>
              <p className="font-body text-xs font-extrabold">Shared room</p>
            </div>
          </div>
          <span className="flex items-center gap-1.5 font-mono text-[0.52rem] uppercase tracking-[0.1em] text-signal">
            <span className="h-1.5 w-1.5 rounded-full bg-signal prototype-presence" />
            online
          </span>
        </div>

        <div className="mt-2 grid grid-cols-[6.1rem_minmax(0,1fr)] gap-2">
          <aside className="rounded-[1.35rem] border border-paper/10 bg-paper/[0.045] p-2" aria-label="Teammates">
            <p className="px-1 pb-2 font-mono text-[0.5rem] uppercase tracking-[0.13em] text-paper/45">Team · 4</p>
            <div className="space-y-1">
              {teammates.map((teammate, index) => {
                const selected = index === activeIndex;
                return (
                  <button
                    key={teammate.name}
                    type="button"
                    onClick={() => setActiveIndex(index)}
                    aria-pressed={selected}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-xl p-1 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal",
                      selected ? "bg-paper/15" : "hover:bg-paper/[0.08]",
                    )}
                  >
                    <CreativeCharacter
                      role={teammate.role}
                      state={selected ? teammate.state : "ready"}
                      label={`${teammate.name}, ${teammate.role}`}
                      className="h-7 w-7 shrink-0 overflow-hidden rounded-lg bg-paper [&>div]:h-full [&>div]:w-full"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-body text-[0.62rem] font-extrabold">{teammate.name}</span>
                      <span className="block truncate font-mono text-[0.43rem] uppercase tracking-[0.05em] text-paper/50">{teammate.role}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="min-w-0 rounded-[1.35rem] border border-paper/10 bg-paper/[0.06] p-3">
            <div className="flex items-start gap-2">
              <CreativeCharacter
                role={active.role}
                state={active.state}
                label={`${active.name}, ${active.role}, ${active.activity}`}
                className="h-10 w-10 shrink-0 overflow-hidden rounded-xl bg-paper [&>div]:h-full [&>div]:w-full"
              />
              <div className="min-w-0 pt-0.5">
                <p className="font-mono text-[0.49rem] uppercase tracking-[0.13em] text-paper/50">{active.role}</p>
                <p className="truncate font-body text-sm font-extrabold">{active.name}</p>
                <p className="mt-0.5 flex items-center gap-1 font-mono text-[0.5rem] uppercase tracking-[0.08em] text-signal">
                  <CircleDot className="h-2.5 w-2.5" aria-hidden="true" />
                  {active.activity}
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-2 font-body text-[0.67rem] leading-relaxed">
              <div className="max-w-[88%] rounded-2xl rounded-tl-sm bg-paper/10 px-2.5 py-2 text-paper/80">
                Build the launch story. Keep the final call with me.
              </div>
              <div className="ml-auto max-w-[91%] rounded-2xl rounded-tr-sm bg-signal px-2.5 py-2 font-semibold text-ink">
                I&apos;m assembling the evidence and assigning the next handoff.
              </div>
            </div>

            <div className="mt-3 rounded-xl border border-signal/35 bg-signal/[0.08] p-2">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-[0.48rem] uppercase tracking-[0.11em] text-signal">Work in motion</p>
                <span className="rounded-full bg-signal px-1.5 py-0.5 font-mono text-[0.43rem] uppercase tracking-[0.07em] text-ink">Active</span>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 text-[0.6rem] text-paper/80">
                <span className="prototype-packet h-1.5 w-1.5 shrink-0 rounded-full bg-clay" />
                {active.name} → organization handoff
                <ArrowUpRight className="ml-auto h-3 w-3 shrink-0 text-signal" aria-hidden="true" />
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2 rounded-xl border border-paper/15 bg-ink/35 px-2.5 py-2 text-paper/45">
              <span className="min-w-0 flex-1 truncate font-body text-[0.6rem]">Message {active.name}…</span>
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-signal text-ink">
                <Send className="h-2.5 w-2.5" aria-hidden="true" />
              </span>
            </div>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between rounded-[1.1rem] border border-paper/10 bg-paper/[0.045] px-3 py-2">
          <span className="font-mono text-[0.49rem] uppercase tracking-[0.1em] text-paper/50">One room. Your call.</span>
          <span className="flex items-center gap-1 font-mono text-[0.48rem] uppercase tracking-[0.08em] text-paper/70"><Check className="h-3 w-3 text-signal" aria-hidden="true" /> review ready</span>
        </div>
      </section>
      <p className="relative mt-4 text-center font-mono text-[0.6rem] uppercase tracking-[0.13em] text-ink-soft">A working workspace prototype</p>
    </div>
  );
}
