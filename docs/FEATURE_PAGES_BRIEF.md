# Feature pages: brief

Written to unblock [chatticus-2378a2](.) (Kanbus), which was parked waiting
on exactly this. Owns the writing and structure decisions for the
`ffac02` epic ("Marketing website: product feature pages and SaaS
positioning"). Implementation (routes, components, visual design) is a
separate pass against this brief, not included here.

## Why this exists

The marketing site's footer currently has a "Project" section (GitHub,
architecture doc, license — repo-facing links). That's contributor-site
framing, not customer-site framing. `2378a2` says it directly: this is a
product site for a bot-farm SaaS, "in the spirit of Grok Bot and
PostHog" — both companies that market background/scheduled agents as a
product category, not just a chat feature. The footer's "Project"
section should become a "Features" section: a growing list of pages
about what Chatticus actually does, each one a real page, not a bullet
in a list.

## The honesty constraint (read this before writing either page)

**Neither of the two features named below is built yet.** I checked:

- **Batch jobs / scheduled savings**: has a serious design memo,
  [`docs/COST_VS_SLA_TRADEOFF.md`](COST_VS_SLA_TRADEOFF.md), written the
  same day as this brief. It's real thinking, not vaporware — but its own
  text says "the argument is mature enough to move from thesis to
  design" (section 12) and lists a scheduler prototype as a *future*
  deliverable. Pre-implementation.
- **Model flexibility (local hardware / SageMaker)**: no design doc, no
  code, nothing beyond the one line in `2378a2`'s description. Thinner
  than batch jobs. Pre-implementation.

This matters because the site spent real effort this session moving
*away* from apologetic "we're early, please forgive us" hedging and
*toward* confident claims — but confident claims still have to be true.
"No vendor lock-in" is true today (MIT license, portable infra, real
code you can inspect). "Chatticus already runs your batch jobs at half
price" is not true today. The fix for both pages is the same pattern
`RealityLedger.tsx` already uses on the home page: state what's live,
what's proven, and what's shipping next, in that order, without
apologizing for the third column. Write these pages as **confident
roadmap pages** — this is where Chatticus is headed and why that
matters to you — not as apologetic "coming soon" placeholders and not as
false present-tense feature documentation. "Ready for buy-in" pages
build in a genuine SaaS motion (see PostHog's changelog/roadmap pages,
or Grok Bot's own announcement post) — visitors expect a mix of shipped
and announced-not-shipped, as long as the page is honest about which is
which.

## Voice rules (carried over from this session's copy work)

- No "X, not Y" contrast pattern more than once per page — it's the
  single most overused AI-writing tell, and this site already leans on
  it elsewhere (headlines like "Four different controls. / None of them
  are chat."). Each page gets at most one, if any.
- No hedging/apologetic framing ("we're just a small team," "still
  early," "please be patient"). Say what's true plainly and let the
  roadmap column carry the not-yet-true part.
- Warm and communal register: "people and bots," not "humans and AI" or
  "your team of intelligent agents."
- Lead with the reader's problem, not the vendor's cleverness. Batch
  jobs page: leads with "your background bots don't need to be fast,
  they need to be cheap and reliable" — not with OpenAI/Anthropic API
  trivia.
- Cite real numbers only when sourced (the memo's 50%/21% distinction in
  particular — see "the two numbers" below). Don't round up.
- Every claim about what Chatticus does today must be checkable against
  actual code/docs, the same standard `Evidence.tsx` already holds the
  home page to.

## Footer restructure

Replace the "Project" `groups` entry in `Footer.tsx` with a "Features"
entry. Structure stays a growing list — add a row per page as it ships:

```
{
  title: "Features",
  links: [
    ["Model flexibility", "/features/model-flexibility"],
    ["Scheduled savings", "/features/scheduled-savings"],
  ],
}
```

The existing "Project" links (source, architecture, license) don't
disappear — they move under "Build," which already exists and is the
right home for them.

## Route convention

New top-level segment: `app/features/[slug]/page.tsx`, one folder per
page (`app/features/model-flexibility/`, `app/features/scheduled-savings/`).
No existing precedent in this repo for content pages (the app only has
`/`, `/chat`, `/auth/*` today) — this establishes the pattern for every
future feature page the epic adds.

## Page 1: Scheduled savings (batch jobs)

**Slug**: `/features/scheduled-savings` (not `/features/batch-jobs` —
"batch" is vendor jargon, same class of problem as "MIT-licensed" was
on the Evidence section; the reader-facing name is what it buys them).

**One-line thesis** (from the memo's own framing, section heading claim):
Chatticus's background bots don't hold a conversation open, so their
work can wait for the cheapest processing lane that still meets the
deadline — without touching model quality.

**Core argument, in reader order**:
1. A named teammate's background work (routines, scheduled tasks) isn't
   like chat — nobody's staring at a spinner waiting for the first
   token.
2. Because of that, work that isn't due for hours or days can run
   through slower, cheaper inference lanes (OpenAI/Anthropic Batch:
   ~50% off eligible tokens) instead of paying for interactive speed it
   doesn't need.
3. This is *not* a cheaper/dumber model — same model, same prompt, same
   tools, just scheduled with patience instead of urgency. ("Give the
   same brain more time," not "replace the model with a cheaper brain."
   This line from the memo is strong enough to be the page's pull-quote.)
4. **The two numbers, stated honestly** — don't let a reader walk away
   thinking "my whole bill drops 50%": Batch is a 50% discount on
   *eligible token spend specifically*, and total-system savings depend
   on what share of spend is eligible inference (the memo's own worked
   example: 60% inference share x 70% eligible x 50% discount = 21%
   total). State both numbers. Rounding "up to 50%" without the
   eligibility caveat is exactly the kind of oversell this brand doesn't
   do.
5. Close on the roadmap honesty: this is the design Chatticus is being
   built around; link out to the technical memo for anyone who wants
   the full argument (the doc is genuinely good and citable — no reason
   to hide it behind a private doc).

**Structure** (mirrors the home page's section rhythm — badge, big
serif headline, supporting paragraph, then a proof/detail block):

- Badge: "How the bill works"
- H1: **"Your bots don't need to be fast. They need to be cheap and
  right."**
- Subhead: One paragraph landing the "same brain, more time" idea in
  plain language — no vendor names yet.
- A short "how it works" 3-step block (mirrors `ControlSystem.tsx`'s
  numbered-card pattern): triggered → queued with patience → delivered
  on schedule.
- A "what this actually saves" block with the two-numbers honesty point
  stated as a real worked example, not a hero stat.
- Roadmap strip (mirrors `RealityLedger.tsx`'s three-column pattern):
  Live foundation (routines/scheduling already exist per `PRODUCT.md`'s
  skills-and-routines section) / Proven in the memo (the cost math,
  provider facts) / Shipping next (the actual scheduler).
- CTA: link to the memo itself for readers who want the primary
  sources, not just a "learn more" dead end.

## Page 2: Model flexibility

**Slug**: `/features/model-flexibility`.

**One-line thesis**: The "no vendor lock-in" promise already on the
home page (Evidence section) extends one layer deeper than code and
infra — to the model itself. You're not locked into paying us, or any
one AI vendor, for the inference.

**Honesty note**: this page has the least to stand on right now. Do not
invent implementation detail (no specific SageMaker instance types, no
claimed local-model list, no "just flip a setting" language). Keep the
page's confident claims to the *positioning* (why this matters, what
kind of freedom it is) and put the *how* plainly in a "designed, not
built" note — don't dress up a one-line epic description as a shipped
integration.

**Structure**:
- Badge: "Own the model, not just the code"
- H1: something in the same family as "No vendor lock-in." from
  Evidence — this page can lean on that headline's exact promise rather
  than reinvent one. Draft: **"Your model, your call."**
- Subhead: ties directly to the Evidence section's MIT-license point —
  the code being yours to take doesn't help if the intelligence behind
  it is a single vendor's API you can't leave. This page closes that gap.
- A short "what this means in practice" list, phrased as intent, not
  instruction: run on hardware you already have, run in your own cloud
  account (AWS SageMaker named explicitly, it's the one concrete detail
  the epic gives us), or use a hosted vendor when that's simpler — your
  choice, not ours.
- Roadmap strip, shorter than page 1's (there's less to report). I
  checked `python/src/chatticus/worker/openai_completion.py` so this
  page doesn't have to guess:
  - **True today**: the worker calls one model through a defined
    `TextCompletionClient` interface (there's already a
    `FakeTextCompletionClient` used for tests) — the seam for a second
    implementation exists.
  - **Not true today, don't imply otherwise**: only one implementation
    exists, and it's hardcoded to OpenAI's API
    (`DEFAULT_OPENAI_MODEL = "gpt-5.6-luna"`, a direct call to
    `api.openai.com`). There is no Anthropic client, no local-model
    client, no SageMaker client, and no per-org/per-bot provider
    selection anywhere in the codebase as of this writing.
  - **Designed next**: an Anthropic, local-hardware, or SageMaker
    implementation of that same interface, plus whatever config surface
    lets an organization choose one.
  - Honest one-line version for the page: "The worker already runs
    behind an interface built to be swapped out. Only one implementation
    exists today — that's the gap this page is describing, not one
    we've already closed."
- CTA: back to the Evidence section's migration-help link (`GET
  MIGRATION HELP` -> anth.us) — same promise, same place to ask.

**Re-verify before publishing**: this file may have changed since this
brief was written. Re-check `python/src/chatticus/worker/` for a second
`TextCompletionClient` implementation before shipping copy that says
"only one implementation exists" — confirm it's still true, don't just
trust this document.

## Open items for whoever implements this

- Exact visual treatment (component reuse from `ControlSystem.tsx` /
  `RealityLedger.tsx` patterns vs. a new one) is a design decision, not
  a copy decision — not specified here.
- Whether `/features` gets an index/listing page or is purely
  footer-linked is undecided; two pages doesn't need one yet, a third
  probably does.
- The Kanbus epic (`ffac02`) has no description of its own; consider
  adding one that points here once this brief is accepted, so the epic
  itself is legible without chasing a doc link.
