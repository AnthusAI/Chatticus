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
 * circle/cobalt, rectangle/signal, square/sea) with names and job-title
 * labels suited to that scenario's use case; a genuinely distinct
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
        id: "nash",
        name: "Nash",
        role: "Editor",
        meta: "Editor",
        motionState: "editing",
        activity: "Reviewing the brief",
        messages: [
          { id: "nash-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Build the launch story. Keep the final call with me." },
          { id: "nash-2", author: "bot", authorLabel: "Nash", body: "I'm assembling the evidence and assigning the next handoff." },
        ],
      },
      {
        id: "wren",
        name: "Wren",
        role: "Reporter",
        meta: "Reporter",
        motionState: "gathering",
        activity: "Finding primary sources",
        messages: [
          { id: "wren-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Who's actually on record for this?" },
          { id: "wren-2", author: "bot", authorLabel: "Wren", body: "Two sources confirmed, one pending a callback before noon." },
        ],
      },
      {
        id: "fable",
        name: "Fable",
        role: "Copy Writer",
        meta: "Copy Writer",
        motionState: "drafting",
        activity: "Drafting the opening",
        messages: [
          { id: "fable-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Lead with the number, not the quote." },
          { id: "fable-2", author: "bot", authorLabel: "Fable", body: "Redrafting the opening now — number first, quote in paragraph two." },
        ],
      },
      {
        id: "inkling",
        name: "Inkling",
        role: "Illustrator",
        meta: "Illustrator",
        motionState: "drawing",
        activity: "Composing the lead art",
        messages: [
          { id: "inkling-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Something that reads at thumbnail size, please." },
          { id: "inkling-2", author: "bot", authorLabel: "Inkling", body: "Three thumbnail-safe compositions coming up for review." },
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
        id: "pirx",
        name: "Pirx",
        role: "Editor",
        meta: "Release Manager",
        motionState: "editing",
        activity: "Reviewing the changelog",
        messages: [
          { id: "pirx-1", author: "operator", authorLabel: "Dana R. · Owner", body: "We ship Thursday. Nothing goes out without your sign-off." },
          { id: "pirx-2", author: "bot", authorLabel: "Pirx", body: "Changelog is drafted. Holding for QA before I approve the tag." },
        ],
      },
      {
        id: "golem",
        name: "Golem",
        role: "Reporter",
        meta: "QA Engineer",
        motionState: "gathering",
        activity: "Triaging overnight failures",
        messages: [
          { id: "golem-1", author: "operator", authorLabel: "Dana R. · Owner", body: "Anything blocking from last night's run?" },
          { id: "golem-2", author: "bot", authorLabel: "Golem", body: "One flaky test, not a regression. Filing it, not blocking release." },
        ],
      },
      {
        id: "trurl",
        name: "Trurl",
        role: "Copy Writer",
        meta: "Docs Writer",
        motionState: "drafting",
        activity: "Rewriting the upgrade guide",
        messages: [
          { id: "trurl-1", author: "operator", authorLabel: "Dana R. · Owner", body: "The migration steps need to be copy-pasteable, not prose." },
          { id: "trurl-2", author: "bot", authorLabel: "Trurl", body: "Rewriting as a numbered command list now." },
        ],
      },
      {
        id: "aniel",
        name: "Aniel",
        role: "Illustrator",
        meta: "Designer",
        motionState: "drawing",
        activity: "Polishing the release banner",
        messages: [
          { id: "aniel-1", author: "operator", authorLabel: "Dana R. · Owner", body: "Keep it on-brand, but make the version number the hero." },
          { id: "aniel-2", author: "bot", authorLabel: "Aniel", body: "Version number's now twice the size, banner's ready for review." },
        ],
      },
    ],
  },
  {
    id: "restaurant",
    useCase: "restaurant openings",
    orgLabel: "Ember & Vine",
    workspaceLabel: "Kitchen Pass",
    members: [
      {
        id: "basil",
        name: "Basil",
        role: "Editor",
        meta: "Head Chef",
        motionState: "editing",
        activity: "Tasting the final plate",
        messages: [
          { id: "basil-1", author: "operator", authorLabel: "Priya N. · Owner", body: "Opening night menu locks tonight. Nothing hits the pass without your taste." },
          { id: "basil-2", author: "bot", authorLabel: "Basil", body: "Tightened the tasting menu to seven courses. Holding the fish until delivery confirms." },
        ],
      },
      {
        id: "sage",
        name: "Sage",
        role: "Reporter",
        meta: "Sourcing Lead",
        motionState: "gathering",
        activity: "Confirming the fish delivery",
        messages: [
          { id: "sage-1", author: "operator", authorLabel: "Priya N. · Owner", body: "Is the halibut actually coming Thursday?" },
          { id: "sage-2", author: "bot", authorLabel: "Sage", body: "Confirmed with the dock — 7am Thursday, backup supplier on standby." },
        ],
      },
      {
        id: "clove",
        name: "Clove",
        role: "Copy Writer",
        meta: "Menu Writer",
        motionState: "drafting",
        activity: "Rewriting the menu copy",
        messages: [
          { id: "clove-1", author: "operator", authorLabel: "Priya N. · Owner", body: "Cut the adjectives. Let the ingredients talk." },
          { id: "clove-2", author: "bot", authorLabel: "Clove", body: "Trimmed every dish description to under ten words." },
        ],
      },
      {
        id: "saffron",
        name: "Saffron",
        role: "Illustrator",
        meta: "Brand Designer",
        motionState: "drawing",
        activity: "Finalizing the menu card",
        messages: [
          { id: "saffron-1", author: "operator", authorLabel: "Priya N. · Owner", body: "The menu card needs to survive candlelight." },
          { id: "saffron-2", author: "bot", authorLabel: "Saffron", body: "Bumped the type size and moved to a warmer paper stock — proofing now." },
        ],
      },
    ],
  },
  {
    id: "cryptid-society",
    useCase: "cryptid research",
    orgLabel: "Pine County Sasquatch Society",
    workspaceLabel: "Field Office",
    members: [
      {
        id: "moss",
        name: "Moss",
        role: "Editor",
        meta: "Lead Investigator",
        motionState: "editing",
        activity: "Reviewing the case file",
        messages: [
          { id: "moss-1", author: "operator", authorLabel: "Hank T. · Chapter Lead", body: "The quarterly report goes to the national society Friday. I want every claim checked before it ships." },
          { id: "moss-2", author: "bot", authorLabel: "Moss", body: "Cross-checking each sighting against the trail-cam timestamps now." },
        ],
      },
      {
        id: "bramble",
        name: "Bramble",
        role: "Reporter",
        meta: "Field Correspondent",
        motionState: "gathering",
        activity: "Interviewing the witness",
        messages: [
          { id: "bramble-1", author: "operator", authorLabel: "Hank T. · Chapter Lead", body: "Is the ridge sighting credible?" },
          { id: "bramble-2", author: "bot", authorLabel: "Bramble", body: "Witness account holds up — matches two prior reports from the same ridge." },
        ],
      },
      {
        id: "thistle",
        name: "Thistle",
        role: "Copy Writer",
        meta: "Dispatch Writer",
        motionState: "drafting",
        activity: "Drafting the member newsletter",
        messages: [
          { id: "thistle-1", author: "operator", authorLabel: "Hank T. · Chapter Lead", body: "Members want facts, not folklore." },
          { id: "thistle-2", author: "bot", authorLabel: "Thistle", body: "Cutting the speculation, leading with the trail-cam data." },
        ],
      },
      {
        id: "hollow",
        name: "Hollow",
        role: "Illustrator",
        meta: "Field Sketch Artist",
        motionState: "drawing",
        activity: "Sketching the track cast",
        messages: [
          { id: "hollow-1", author: "operator", authorLabel: "Hank T. · Chapter Lead", body: "Get the toe spacing right this time." },
          { id: "hollow-2", author: "bot", authorLabel: "Hollow", body: "Redrawing from the plaster cast — toe spacing now to scale." },
        ],
      },
    ],
  },
];
