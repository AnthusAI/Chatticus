"use client";

import { useEffect, useRef, useState } from "react";
import type { BotAvatarState, CreativeMotionState } from "anthus-vultus";
import { cn } from "@/lib/utils";
import { WorkspacePanel } from "./WorkspacePanel";
import { DEMO_SCENARIOS } from "./demoScenarios";

const MOTION_STATE_TO_AVATAR_STATE: Record<CreativeMotionState, BotAvatarState> = {
  ready: "neutral",
  gathering: "thinking",
  drafting: "speakingOpen",
  drawing: "toolCalling",
  editing: "toolResponse",
  complete: "speakingComplete",
};

/** How long each teammate holds focus before the next beat (or the next scenario) starts. */
const BEAT_MS = 2200;
/** Duration of the exit/enter slide when one scenario swaps for the next. */
const TRANSITION_MS = 450;

type TransitionPhase = "idle" | "exiting" | "entering";

/**
 * The marketing hero's live preview of the real Workspace UI (WorkspacePanel) —
 * fed a small scripted transcript instead of live API/SSE data. This is the
 * same component EnabledWorkspace renders for the real, authenticated app.
 *
 * Cycles through DEMO_SCENARIOS: within a scenario, each teammate gets a
 * ~2s beat of focus in turn; once the last teammate's beat finishes, the
 * whole panel slides out and the next scenario's panel slides in.
 */
export function WorkspaceDemo() {
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [beatIndex, setBeatIndex] = useState(0);
  const [phase, setPhase] = useState<TransitionPhase>("idle");
  const [paused, setPaused] = useState(false);

  const scenario = DEMO_SCENARIOS[scenarioIndex];

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Single self-scheduling timer chain (not several useEffects that
  // re-subscribe on every state change): that pattern races under React's
  // dev-mode double-invocation of effects, producing skipped/repeated
  // beats. This effect runs once, owns its own recursive setTimeout loop,
  // and cancels cleanly on unmount via the `cancelled` flag.
  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    function after(delay: number, action: () => void) {
      timeoutId = setTimeout(() => {
        if (cancelled) {
          return;
        }
        if (pausedRef.current) {
          after(200, action);
          return;
        }
        action();
      }, delay);
    }

    function runBeat(currentScenario: number, currentBeat: number) {
      after(BEAT_MS, () => {
        const members = DEMO_SCENARIOS[currentScenario].members;
        if (currentBeat < members.length - 1) {
          const nextBeat = currentBeat + 1;
          setBeatIndex(nextBeat);
          runBeat(currentScenario, nextBeat);
          return;
        }
        setPhase("exiting");
        after(TRANSITION_MS, () => {
          const nextScenario = (currentScenario + 1) % DEMO_SCENARIOS.length;
          setScenarioIndex(nextScenario);
          setBeatIndex(0);
          setPhase("entering");
          after(TRANSITION_MS, () => {
            setPhase("idle");
            runBeat(nextScenario, 0);
          });
        });
      });
    }

    runBeat(0, 0);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, []);

  const active = scenario.members[beatIndex] ?? scenario.members[0];

  return (
    <div>
      <p className="mb-3 animate-rise text-center font-mono text-[0.7rem] uppercase tracking-[0.12em] text-ink-soft [animation-delay:300ms] lg:text-left">
        A team of bots and people working on{" "}
        <span
          key={scenario.id}
          className={cn(
            "inline-block text-clay transition-all duration-300",
            phase === "exiting" ? "-translate-y-1 opacity-0" : "translate-y-0 opacity-100",
          )}
        >
          {scenario.useCase}
        </span>
        .
      </p>
      <div
        className="workspace-prototype relative mx-auto w-[70%] max-w-[19rem] lg:w-full lg:max-w-[21rem]"
        data-motion-paused={paused ? "true" : "false"}
      >
        <div aria-hidden="true" className="prototype-backing-plane" />
        <div aria-hidden="true" className="prototype-shadow-plane" />
        <div
          className={cn(
            "relative z-10 transition-all duration-300 ease-out",
            phase === "exiting"
              ? "-translate-y-3 opacity-0"
              : phase === "entering"
                ? "translate-y-3 opacity-0"
                : "translate-y-0 opacity-100",
          )}
        >
          <WorkspacePanel
            orgLabel={scenario.orgLabel}
            workspaceLabel={scenario.workspaceLabel}
            members={scenario.members}
            selectedMemberId={active.id}
            selectedMemberState={paused ? "neutral" : MOTION_STATE_TO_AVATAR_STATE[active.motionState]}
            selectedMemberActivity={active.activity}
            messages={active.messages}
            draft=""
            sending={false}
            disabled
            composerPlaceholder={`Message ${active.name}…`}
            onSelectMember={(member) => {
              const index = scenario.members.findIndex((candidate) => candidate.id === member.id);
              if (index >= 0) {
                setBeatIndex(index);
              }
            }}
            onDraftChange={() => {}}
            onSend={() => {}}
            paused={paused}
            onTogglePaused={() => setPaused((current) => !current)}
          />
        </div>
      </div>
    </div>
  );
}
