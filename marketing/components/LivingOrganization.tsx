"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ArrowRight, Check, MousePointer2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { CreativeCharacter } from "@/components/CreativeCharacter";
import type { CreativeMotionState, CreativeRole } from "anthus-vultus";

type Teammate = {
  name: string;
  role: CreativeRole;
  accent: string;
};

type Scene = {
  activeIndex: number;
  state: CreativeMotionState;
  stateLabel: string;
  detail: string;
};

const teammates: Teammate[] = [
  { name: "Marin", role: "Editor", accent: "var(--clay)" },
  { name: "Nell", role: "Reporter", accent: "var(--cobalt)" },
  { name: "June", role: "Copy Writer", accent: "var(--signal)" },
  { name: "Sol", role: "Illustrator", accent: "var(--sea)" },
];

const scenes: Scene[] = [
  {
    activeIndex: 1,
    state: "gathering",
    stateLabel: "Gathering facts",
    detail: "Nell is filing notes and source links from the field.",
  },
  {
    activeIndex: 2,
    state: "drafting",
    stateLabel: "Drafting copy",
    detail: "June is turning the reporting into a clear first draft.",
  },
  {
    activeIndex: 3,
    state: "drawing",
    stateLabel: "Drawing",
    detail: "Sol is building the lead illustration in the shared studio.",
  },
  {
    activeIndex: 0,
    state: "editing",
    stateLabel: "Editing",
    detail: "Marin is checking the story, evidence, and visual as one piece.",
  },
];

export function LivingOrganization() {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(media.matches);
    updatePreference();
    media.addEventListener("change", updatePreference);
    return () => media.removeEventListener("change", updatePreference);
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      return;
    }
    const interval = window.setInterval(() => {
      setSceneIndex((current) => (current + 1) % scenes.length);
    }, 3600);
    return () => window.clearInterval(interval);
  }, [reducedMotion]);

  const scene = scenes[sceneIndex];
  const activeTeammate = teammates[scene.activeIndex];
  const announcement = useMemo(
    () => `${activeTeammate.name}: ${scene.stateLabel}. ${scene.detail}`,
    [activeTeammate.name, scene.detail, scene.stateLabel],
  );

  return (
    <div className="relative mx-auto w-full max-w-[43rem]">
      <div className="absolute -inset-3 rotate-2 rounded-[2.4rem] bg-signal" />
      <div className="organization-stage relative overflow-hidden rounded-[2rem] border-2 border-ink bg-ink p-4 text-paper shadow-[10px_12px_0_rgba(17,19,15,0.16)] sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-4 border-b border-paper/20 pb-4">
          <div>
            <p className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-paper/60">
              Your organization
            </p>
            <p className="mt-1 font-body text-sm font-bold">One shared room</p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-signal/50 bg-signal/10 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-[0.12em] text-signal">
            <span className="h-2 w-2 rounded-full bg-signal shadow-[0_0_0_4px_rgba(184,243,74,0.12)]" />
            Work in progress
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4">
          {teammates.map((teammate, index) => {
            const active = index === scene.activeIndex;
            const avatarState: CreativeMotionState = reducedMotion
              ? "ready"
              : active
                ? scene.state
                : "ready";
            return (
              <button
                key={teammate.name}
                type="button"
                aria-pressed={active}
                aria-label={`Show ${teammate.name}, ${teammate.role}`}
                onClick={() => {
                  const nextScene = scenes.findIndex(
                    (candidate) => candidate.activeIndex === index,
                  );
                  setSceneIndex(nextScene >= 0 ? nextScene : 0);
                }}
                className={cn(
                  "group relative min-w-0 rounded-[1.25rem] border p-2 text-left transition duration-300 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-signal/35 sm:p-3",
                  active
                    ? "-translate-y-1 border-signal bg-paper/10"
                    : "border-paper/[0.15] bg-paper/[0.035] hover:border-paper/[0.35]",
                )}
                style={{ "--teammate-accent": teammate.accent } as CSSProperties}
              >
                <span className="relative block aspect-square overflow-hidden rounded-[1rem] bg-paper">
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-3 bottom-1 h-2 rounded-full bg-[var(--teammate-accent)] opacity-60 blur-md"
                  />
                  <CreativeCharacter
                    role={teammate.role}
                    state={avatarState}
                    label={`${teammate.name}, ${teammate.role}: ${active ? scene.stateLabel : "ready"}`}
                    className="absolute inset-0 flex items-center justify-center [&>div]:h-full [&>div]:w-full"
                  />
                </span>
                <span className="mt-3 block truncate font-body text-xs font-extrabold sm:text-sm">
                  {teammate.name}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[0.56rem] uppercase tracking-[0.11em] text-paper/[0.55] sm:text-[0.65rem]">
                  {teammate.role}
                </span>
                <span className="mt-2 block truncate rounded-full bg-paper/10 px-2 py-1 font-mono text-[0.5rem] uppercase tracking-[0.08em] text-paper/70 sm:text-[0.56rem]">
                  {active ? scene.stateLabel : "Ready"}
                </span>
                {active ? (
                  <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-signal text-ink sm:right-3 sm:top-3">
                    <MousePointer2 className="h-3 w-3" aria-hidden="true" />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="mt-4 grid gap-3 rounded-[1.25rem] border border-paper/[0.15] bg-paper/[0.05] p-4 sm:grid-cols-[auto_1fr_auto] sm:items-center">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-clay text-ink">
            <Check className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <p className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-paper/[0.55]">
              Live handoff
            </p>
            <p className="mt-1 font-body text-sm font-semibold" aria-live="polite">
              {announcement}
            </p>
          </div>
          <ArrowRight className="hidden h-5 w-5 text-signal sm:block" aria-hidden="true" />
        </div>

        <div className="mt-4 flex gap-2" aria-label="Animation scene controls">
          {scenes.map((candidate, index) => (
            <button
              key={`${candidate.activeIndex}-${candidate.state}`}
              type="button"
              aria-label={`Show scene ${index + 1}`}
              aria-current={index === sceneIndex ? "true" : undefined}
              onClick={() => setSceneIndex(index)}
              className={cn(
                "h-1.5 flex-1 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal",
                index === sceneIndex ? "bg-signal" : "bg-paper/20",
              )}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
