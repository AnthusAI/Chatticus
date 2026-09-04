# News desk: Updates and Agent Zoo

Editor guide for the chattic.us marketing blog. Direct, clear, no hedging, no emojis.

## The beat

A product category is forming: persistent multi-agent workplaces — named bots that hold jobs, share a computer, run in the background, and do useful work together. One good picture of the same idea: a reactor chamber for AI agents to collaborate and do useful work. The industry has not settled on a word. The thing is stable; the jargon moves.

## Public name is Agent Zoo

That is Chatticus's name for the category desk. Never name the blog "Model Zoo" or "the model zoo."

## Synonyms the desk covers

These are names you will see in the wild for the same idea. They are not names for the blog. Keep this as a living list; extend it when a new coinage names the same workplace where agents collaborate and do useful work:

- software factory
- bot farm
- model zoo (one name in the wild; not ours)
- agent org
- reactor chamber
- foundry
- shop floor
- yard (as in shipyard: concurrent work in one place)
- studio

Add further synonyms when they name the same idea: a workplace where agents collaborate and do useful work.

## Who is in the zoo

Coverage includes Chatticus and peers such as Gastown, Grok Bot, and PostHog's agent/cowork work, plus new entries as they appear. This desk MAY name third-party products. That does NOT license renaming Chatticus bots, the computer, skills, routines, or the worker protocol after them. Root `AGENTS.md` still holds for product code.

## Updates vs Agent Zoo

**Updates** — Chatticus's own progress notes. Honesty like `docs/FEATURE_PAGES_BRIEF.md` (live / proven / shipping). Checkable claims.

**Agent Zoo** — the trade desk about the category. Chatticus product changelog does not belong here. Generic LLM or model-release news does not belong unless it changes how a farm actually runs.

## Voice

Chatticus is a participant, not a press office and not an outside reviewer of itself. Warm communal register ("people and bots"). No hedging empty-states ("coming soon", "we're just getting started"). At most one "X, not Y" contrast per page. Claims about Chatticus must be checkable.

## How to publish

- Posts live in git: `web/content/blog/updates/*.md` and `web/content/blog/agent-zoo/*.md`
- Category is the **folder**, not frontmatter
- Frontmatter: `title`, `date`, `description`, `ogHeadline`, `ogTagline`, optional `draft`
- Filename is `{slug}.md`
- `draft: true` excluded from listings
- Drop a `.md` file, rebuild the site. No CMS.
