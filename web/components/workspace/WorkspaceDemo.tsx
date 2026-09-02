"use client";

import { useState } from "react";
import type { BotAvatarState, CreativeMotionState } from "anthus-vultus";
import { WorkspacePanel } from "./WorkspacePanel";
import { DEMO_MEMBERS } from "./demoWorkspaceData";

const MOTION_STATE_TO_AVATAR_STATE: Record<CreativeMotionState, BotAvatarState> = {
  ready: "neutral",
  gathering: "thinking",
  drafting: "speakingOpen",
  drawing: "toolCalling",
  editing: "toolResponse",
  complete: "speakingComplete",
};

/**
 * The marketing hero's live preview of the real Workspace UI (WorkspacePanel) —
 * fed a small scripted transcript instead of live API/SSE data. This is the
 * same component EnabledWorkspace renders for the real, authenticated app.
 */
export function WorkspaceDemo() {
  const [activeId, setActiveId] = useState(DEMO_MEMBERS[0].id);
  const [paused, setPaused] = useState(false);
  const active = DEMO_MEMBERS.find((member) => member.id === activeId) ?? DEMO_MEMBERS[0];

  return (
    <div
      className="workspace-prototype relative mx-auto w-[85%] max-w-[28rem] lg:w-full lg:max-w-[31rem]"
      data-motion-paused={paused ? "true" : "false"}
    >
      <div aria-hidden="true" className="prototype-backing-plane" />
      <div aria-hidden="true" className="prototype-shadow-plane" />
      <div className="relative z-10">
        <WorkspacePanel
          orgLabel="Acme Corp Magazines"
          workspaceLabel="Newsroom"
          members={DEMO_MEMBERS}
          selectedMemberId={active.id}
          selectedMemberState={paused ? "neutral" : MOTION_STATE_TO_AVATAR_STATE[active.motionState]}
          selectedMemberActivity={active.activity}
          messages={active.messages}
          draft=""
          sending={false}
          disabled
          composerPlaceholder={`Message ${active.name}…`}
          onSelectMember={(member) => setActiveId(member.id)}
          onDraftChange={() => {}}
          onSend={() => {}}
          paused={paused}
          onTogglePaused={() => setPaused((current) => !current)}
        />
      </div>
    </div>
  );
}
