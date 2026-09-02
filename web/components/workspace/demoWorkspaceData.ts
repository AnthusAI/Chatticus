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
    id: "pirx",
    name: "Pirx",
    role: "Editor",
    meta: "Editor",
    motionState: "editing",
    activity: "Reviewing the brief",
    messages: [
      { id: "pirx-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Build the launch story. Keep the final call with me." },
      { id: "pirx-2", author: "bot", authorLabel: "Pirx", body: "I'm assembling the evidence and assigning the next handoff." },
    ],
  },
  {
    id: "golem",
    name: "Golem",
    role: "Reporter",
    meta: "Reporter",
    motionState: "gathering",
    activity: "Finding primary sources",
    messages: [
      { id: "golem-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Who's actually on record for this?" },
      { id: "golem-2", author: "bot", authorLabel: "Golem", body: "Two sources confirmed, one pending a callback before noon." },
    ],
  },
  {
    id: "trurl",
    name: "Trurl",
    role: "Copy Writer",
    meta: "Copy Writer",
    motionState: "drafting",
    activity: "Drafting the opening",
    messages: [
      { id: "trurl-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Lead with the number, not the quote." },
      { id: "trurl-2", author: "bot", authorLabel: "Trurl", body: "Redrafting the opening now — number first, quote in paragraph two." },
    ],
  },
  {
    id: "aniel",
    name: "Aniel",
    role: "Illustrator",
    meta: "Illustrator",
    motionState: "drawing",
    activity: "Composing the lead art",
    messages: [
      { id: "aniel-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Something that reads at thumbnail size, please." },
      { id: "aniel-2", author: "bot", authorLabel: "Aniel", body: "Three thumbnail-safe compositions coming up for review." },
    ],
  },
];
