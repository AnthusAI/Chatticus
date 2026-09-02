import type { CreativeMotionState } from "anthus-vultus";
import type { WorkspaceMember, WorkspaceMessage } from "./types";

export type DemoMember = WorkspaceMember & {
  motionState: CreativeMotionState;
  activity: string;
  messages: WorkspaceMessage[];
};

/** Scripted transcript for the marketing hero's live demo of the real Workspace UI — no network calls from the public site. */
export const DEMO_MEMBERS: DemoMember[] = [
  {
    id: "marin",
    name: "Marin",
    role: "Editor",
    meta: "Editor",
    motionState: "editing",
    activity: "Reviewing the brief",
    messages: [
      { id: "marin-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Build the launch story. Keep the final call with me." },
      { id: "marin-2", author: "bot", authorLabel: "Marin", body: "I'm assembling the evidence and assigning the next handoff." },
    ],
  },
  {
    id: "nell",
    name: "Nell",
    role: "Reporter",
    meta: "Reporter",
    motionState: "gathering",
    activity: "Finding primary sources",
    messages: [
      { id: "nell-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Who's actually on record for this?" },
      { id: "nell-2", author: "bot", authorLabel: "Nell", body: "Two sources confirmed, one pending a callback before noon." },
    ],
  },
  {
    id: "june",
    name: "June",
    role: "Copy Writer",
    meta: "Copy Writer",
    motionState: "drafting",
    activity: "Drafting the opening",
    messages: [
      { id: "june-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Lead with the number, not the quote." },
      { id: "june-2", author: "bot", authorLabel: "June", body: "Redrafting the opening now — number first, quote in paragraph two." },
    ],
  },
  {
    id: "sol",
    name: "Sol",
    role: "Illustrator",
    meta: "Illustrator",
    motionState: "drawing",
    activity: "Composing the lead art",
    messages: [
      { id: "sol-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Something that reads at thumbnail size, please." },
      { id: "sol-2", author: "bot", authorLabel: "Sol", body: "Three thumbnail-safe compositions coming up for review." },
    ],
  },
];
