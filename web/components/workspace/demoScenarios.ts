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
 * four of Vultus's eight character archetypes (Editor/Reporter/Copy
 * Writer/Illustrator/Producer/Researcher/Archivist/Analyst), varied
 * scenario to scenario so the carousel doesn't show the same four
 * silhouettes on repeat -- every scenario differs from its neighbors (in
 * carousel order, wrapping around) by at least two of its four characters.
 * `role` picks the character archetype; `meta` is just the on-screen job
 * title and doesn't need to match it literally.
 *
 * Each member's messages are choreographed via WorkspaceMessage's
 * typingBeforeMs/reaction fields (see WorkspaceThread's reveal logic) --
 * deliberately varied per beat (typing on the human side, typing on the
 * bot side, an instant reply, no reply at all, a delayed human reaction)
 * rather than the same pattern repeated across every member. No two
 * patterns repeat within one scenario; the *order* of patterns is also
 * varied scenario to scenario so the carousel as a whole doesn't read as
 * a template applied five times.
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
          // Instant: a decisive editor who already had the call ready.
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
          // Bot-typing: the pause dramatizes actually checking sources.
          { id: "wren-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Who's actually on record for this?" },
          { id: "wren-2", author: "bot", authorLabel: "Wren", body: "Two sources confirmed, one pending a callback before noon.", typingBeforeMs: 1700 },
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
          // Human-typing: an owner composing precise creative direction.
          { id: "fable-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Lead with the number, not the quote.", typingBeforeMs: 1500 },
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
          // Delayed reaction: the warm close, a finished visual earns a nod.
          { id: "inkling-1", author: "operator", authorLabel: "Maya K. · Owner", body: "Something that reads at thumbnail size, please." },
          {
            id: "inkling-2",
            author: "bot",
            authorLabel: "Inkling",
            body: "Three thumbnail-safe compositions coming up for review.",
            typingBeforeMs: 1200,
            reaction: { emoji: "👍", delayMs: 2400 },
          },
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
        role: "Producer",
        meta: "Release Manager",
        motionState: "editing",
        activity: "Reviewing the changelog",
        messages: [
          // Human-typing: weighing a real deadline before committing it.
          { id: "pirx-1", author: "operator", authorLabel: "Dana R. · Owner", body: "We ship Thursday. Nothing goes out without your sign-off.", typingBeforeMs: 1600 },
          { id: "pirx-2", author: "bot", authorLabel: "Pirx", body: "Changelog is drafted. Holding for QA before I approve the tag." },
        ],
      },
      {
        id: "golem",
        name: "Golem",
        role: "Analyst",
        meta: "QA Engineer",
        motionState: "gathering",
        activity: "Triaging overnight failures",
        messages: [
          // Bot-typing: the pause is Golem actually triaging, not chatting.
          { id: "golem-1", author: "operator", authorLabel: "Dana R. · Owner", body: "Anything blocking from last night's run?" },
          { id: "golem-2", author: "bot", authorLabel: "Golem", body: "One flaky test, not a regression. Filing it, not blocking release.", typingBeforeMs: 1700 },
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
          // No response: docs rewrites are heads-down work.
          { id: "trurl-1", author: "operator", authorLabel: "Dana R. · Owner", body: "The migration steps need to be copy-pasteable, not prose." },
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
          // Delayed reaction: design approval closes the loop, visibly.
          { id: "aniel-1", author: "operator", authorLabel: "Dana R. · Owner", body: "Keep it on-brand, but make the version number the hero." },
          {
            id: "aniel-2",
            author: "bot",
            authorLabel: "Aniel",
            body: "Version number's now twice the size, banner's ready for review.",
            typingBeforeMs: 1000,
            reaction: { emoji: "👍", delayMs: 2400 },
          },
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
          // Bot-typing: the pause literalizes tasting before the verdict.
          { id: "basil-1", author: "operator", authorLabel: "Priya N. · Owner", body: "Opening night menu locks tonight. Nothing hits the pass without your taste." },
          { id: "basil-2", author: "bot", authorLabel: "Basil", body: "Tightened the tasting menu to seven courses. Holding the fish until delivery confirms.", typingBeforeMs: 1800 },
        ],
      },
      {
        id: "sage",
        name: "Sage",
        role: "Researcher",
        meta: "Sourcing Lead",
        motionState: "gathering",
        activity: "Confirming the fish delivery",
        messages: [
          // Instant: logistics answered fast, no drama.
          { id: "sage-1", author: "operator", authorLabel: "Priya N. · Owner", body: "Is the halibut actually coming Thursday?" },
          { id: "sage-2", author: "bot", authorLabel: "Sage", body: "Confirmed with the dock — 7am Thursday, backup supplier on standby." },
        ],
      },
      {
        id: "clove",
        name: "Clove",
        role: "Archivist",
        meta: "Menu Writer",
        motionState: "drafting",
        activity: "Rewriting the menu copy",
        messages: [
          // Human-typing: exact creative direction, not a fired-off note.
          { id: "clove-1", author: "operator", authorLabel: "Priya N. · Owner", body: "Cut the adjectives. Let the ingredients talk.", typingBeforeMs: 1500 },
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
          // No response: quiet motion, the calm before doors open.
          { id: "saffron-1", author: "operator", authorLabel: "Priya N. · Owner", body: "The menu card needs to survive candlelight." },
        ],
      },
    ],
  },
  {
    id: "observatory",
    useCase: "astrophysics",
    orgLabel: "Kepler Ridge Observatory",
    workspaceLabel: "Control Room",
    members: [
      {
        id: "corvus",
        name: "Corvus",
        role: "Editor",
        meta: "Principal Investigator",
        motionState: "editing",
        activity: "Reviewing the transit fit",
        messages: [
          // Human-typing: careful phrasing mirrors scientific caution.
          { id: "corvus-1", author: "operator", authorLabel: "Dr. Reyes · Lab Director", body: "The journal wants the draft by Monday. Nothing goes out without my sign-off.", typingBeforeMs: 1600 },
          { id: "corvus-2", author: "bot", authorLabel: "Corvus", body: "Cross-checking the transit depth against the calibration run now." },
        ],
      },
      {
        id: "vela",
        name: "Vela",
        role: "Researcher",
        meta: "Observational Astronomer",
        motionState: "gathering",
        activity: "Confirming the second transit",
        messages: [
          // Bot-typing: the pause dramatizes verification itself.
          { id: "vela-1", author: "operator", authorLabel: "Dr. Reyes · Lab Director", body: "Is the signal even real?" },
          { id: "vela-2", author: "bot", authorLabel: "Vela", body: "Confirmed across two nights — same depth, same period, not an artifact.", typingBeforeMs: 1700 },
        ],
      },
      {
        id: "nova",
        name: "Nova",
        role: "Copy Writer",
        meta: "Paper Writer",
        motionState: "drafting",
        activity: "Rewriting the abstract",
        messages: [
          // No response: a revision pass is invisible work.
          { id: "nova-1", author: "operator", authorLabel: "Dr. Reyes · Lab Director", body: "Cut the hedging. State the confidence interval plainly." },
        ],
      },
      {
        id: "halley",
        name: "Halley",
        role: "Analyst",
        meta: "Data Viz Lead",
        motionState: "drawing",
        activity: "Simplifying the light curve",
        messages: [
          // Delayed reaction: the most gratifying deliverable earns the nod.
          { id: "halley-1", author: "operator", authorLabel: "Dr. Reyes · Lab Director", body: "The light curve plot needs to read on a phone screen." },
          {
            id: "halley-2",
            author: "bot",
            authorLabel: "Halley",
            body: "Simplified to the folded light curve — noise trimmed, transit dip obvious.",
            typingBeforeMs: 1000,
            reaction: { emoji: "👍", delayMs: 2400 },
          },
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
        role: "Producer",
        meta: "Lead Investigator",
        motionState: "editing",
        activity: "Reviewing the case file",
        messages: [
          // Human-typing: a chapter lead weighing the stakes before typing.
          { id: "moss-1", author: "operator", authorLabel: "Hank T. · Chapter Lead", body: "The quarterly report goes to the national society Friday. I want every claim checked before it ships.", typingBeforeMs: 1600 },
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
          // Instant: a confident field correspondent, no hedging.
          { id: "bramble-1", author: "operator", authorLabel: "Hank T. · Chapter Lead", body: "Is the ridge sighting credible?" },
          { id: "bramble-2", author: "bot", authorLabel: "Bramble", body: "Witness account holds up — matches two prior reports from the same ridge." },
        ],
      },
      {
        id: "thistle",
        name: "Thistle",
        role: "Archivist",
        meta: "Dispatch Writer",
        motionState: "drafting",
        activity: "Drafting the member newsletter",
        messages: [
          // No response: already turned to the rewrite, not narrating it.
          { id: "thistle-1", author: "operator", authorLabel: "Hank T. · Chapter Lead", body: "Members want facts, not folklore." },
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
          // Delayed reaction: a corrected sketch earns a satisfied nod.
          { id: "hollow-1", author: "operator", authorLabel: "Hank T. · Chapter Lead", body: "Get the toe spacing right this time." },
          {
            id: "hollow-2",
            author: "bot",
            authorLabel: "Hollow",
            body: "Redrawing from the plaster cast — toe spacing now to scale.",
            typingBeforeMs: 1200,
            reaction: { emoji: "👍", delayMs: 2400 },
          },
        ],
      },
    ],
  },
];
