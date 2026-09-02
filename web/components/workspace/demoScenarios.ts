import type { CreativeMotionState } from "anthus-vultus";
import type { WorkspaceMember, WorkspaceMessage } from "./types";

export type DemoMember = WorkspaceMember & {
  motionState: CreativeMotionState;
  activity: string;
  messages: WorkspaceMessage[];
};

export type DemoScenario = {
  id: string;
  /** Fills the hero caption: "A team of bots and people working on {useCase}." */
  useCase: string;
  orgLabel: string;
  workspaceLabel: string;
  members: DemoMember[];
};

/**
 * Scripted transcripts for the marketing hero's live demo of the real
 * Workspace UI — no network calls from the public site. Each scenario casts
 * the same four character archetypes Vultus's character system currently
 * ships (Editor/Reporter/Copy Writer/Illustrator -- capsule/clay,
 * circle/cobalt, rectangle/signal, square/sea) with different names and
 * job-title labels suited to that scenario's use case; a genuinely distinct
 * shape/color per scenario would need new archetypes added to Vultus itself.
 */
export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: "newsroom",
    useCase: "magazines",
    orgLabel: "Acme Corp Magazines",
    workspaceLabel: "Newsroom",
    members: [
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
    ],
  },
  {
    id: "release-room",
    useCase: "software releases",
    orgLabel: "Nimbus Cloud Systems",
    workspaceLabel: "Release Room",
    members: [
      {
        id: "vex",
        name: "Vex",
        role: "Editor",
        meta: "Release Manager",
        motionState: "editing",
        activity: "Reviewing the changelog",
        messages: [
          { id: "vex-1", author: "operator", authorLabel: "Dana R. · Owner", body: "We ship Thursday. Nothing goes out without your sign-off." },
          { id: "vex-2", author: "bot", authorLabel: "Vex", body: "Changelog is drafted. Holding for QA before I approve the tag." },
        ],
      },
      {
        id: "sable",
        name: "Sable",
        role: "Reporter",
        meta: "QA Engineer",
        motionState: "gathering",
        activity: "Triaging overnight failures",
        messages: [
          { id: "sable-1", author: "operator", authorLabel: "Dana R. · Owner", body: "Anything blocking from last night's run?" },
          { id: "sable-2", author: "bot", authorLabel: "Sable", body: "One flaky test, not a regression. Filing it, not blocking release." },
        ],
      },
      {
        id: "quill",
        name: "Quill",
        role: "Copy Writer",
        meta: "Docs Writer",
        motionState: "drafting",
        activity: "Rewriting the upgrade guide",
        messages: [
          { id: "quill-1", author: "operator", authorLabel: "Dana R. · Owner", body: "The migration steps need to be copy-pasteable, not prose." },
          { id: "quill-2", author: "bot", authorLabel: "Quill", body: "Rewriting as a numbered command list now." },
        ],
      },
      {
        id: "isca",
        name: "Isca",
        role: "Illustrator",
        meta: "Designer",
        motionState: "drawing",
        activity: "Polishing the release banner",
        messages: [
          { id: "isca-1", author: "operator", authorLabel: "Dana R. · Owner", body: "Keep it on-brand, but make the version number the hero." },
          { id: "isca-2", author: "bot", authorLabel: "Isca", body: "Version number's now twice the size, banner's ready for review." },
        ],
      },
    ],
  },
];
