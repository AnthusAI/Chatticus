# Marketing wiki

Editor guide for the chattic.us public encyclopedia. Direct, clear, no hedging, no emojis.

## Wiki vs blog vs Kanbus wiki

**This wiki** — the public encyclopedia on chattic.us. **Idea pages**, not a competitor catalog. Stable concepts (what an agent workplace is, what a farm is, what a software factory is as an idea). Current events do not get their own wiki pages; they attach as related Agent Zoo / Updates posts.

**Blog** — dated desks under `web/content/blog/`:
- **Updates** — Chatticus progress notes.
- **Agent Zoo** — the trade desk about agent workplaces (the public name for that news desk).

**Kanbus `project/wiki/competitive-landscape/`** — the internal record: one page per product, overlap scores, kill lists, freshness, blunt positioning. Not tailored for marketing. Do not copy that tree onto the site. Never edit `project/` issue JSON by hand; wiki markdown under `project/wiki/` is allowed.

| | Public wiki | Kanbus landscape wiki |
| --- | --- | --- |
| General ideas | Yes — this is the spine | Yes, as category pages |
| Current events | Related blog posts on the idea page | Freshness notes on product pages |
| One page per competitor | No | Yes |
| Overlap, pricing, kill lists | No | Yes |
| Voice | Warm, participant, checkable | Internal, blunt |

## Public name of the news desk

The news desk is still **Agent Zoo**. That is not the name of the workplace and not a public wiki section titled "competitors." The wiki may document "model zoo" as one name in the wild; that is not the wiki's own name.

## Information architecture

Public pages are **ideas** plus **product source** rendered from `docs/` (and `LICENSE`) by Markus. A vendor may appear as an example in a sentence. A vendor does not get a slug.

Published idea pages:

| Slug | Idea |
| --- | --- |
| `agent-workplace` | The thing: a durable place where named agents collaborate and do useful work (reactor chamber). |
| `names-for-the-workplace` | Vocabulary: factory, farm, zoo, office, reactor; what to say and what to avoid. |
| `named-teammates` | Persistent named bots with roles, not a fresh chat. |
| `shared-computer` | One workplace computer (files, browser, terminal), not a per-bot security boundary. |
| `farms-and-desks` | Throughput org of specialized desks, not one generalist and not an undifferentiated swarm. |
| `software-factory` | SDLC as a production line — the *idea*. Factory.ai is an example, not a product homepage here. |
| `digital-labor` | Enterprise "AI coworker / digital workforce" vocabulary and how it differs from a shared-computer farm. |
| `always-on` | Personal always-on agents vs a multi-desk workplace. |

Do not add `grok-bot.md`, `factory.md`, `gas-town.md`, or any other product slug. Deep notes on those products live in Kanbus.

Feature pages under `/features/` stay product-marketing pages. They link to wiki product docs, not GitHub blobs.

Product source pages (Markus-rendered from `docs/` and `LICENSE`, not copied into `web/content/wiki/`): `product`, `roadmap`, `architecture`, `design-challenges`, `messaging`, `computer-manifold`, `cost-vs-sla`, `license`. Other public `docs/*.md` files get unlisted wiki routes so in-doc links stay on-site.

## How current events attach

Agent Zoo (and sometimes Updates) writes the dated piece. The idea page lists it in `relatedPosts`. The post lists the idea in `relatedWiki`.

Do not create wiki pages named after a week's news. If an event changes the *idea*, edit the idea page; if it is news about the idea, write a post.

## Voice

Warm communal register. Chatticus is a participant. No hedging empty-states ("coming soon"). At most one "X, not Y" contrast per page. Claims about Chatticus must be checkable. Vendors may appear as examples in a sentence; they do not get a slug or a dossier.

## Frontmatter

Each page is `web/content/wiki/{slug}.md`. Required fields:

- `title`
- `description`
- `ogHeadline`
- `ogTagline`
- optional `draft` (bool)
- optional `relatedPosts` — YAML list of `category/slug` strings pointing at blog posts, for example:

```yaml
relatedPosts:
  - updates/first-week
  - agent-zoo/gastown
```

Blog posts may list wiki slugs in optional `relatedWiki`:

```yaml
relatedWiki:
  - agent-workplace
```

Missing targets are omitted when resolving links; they must not fail the build.

## Draft research notes

`draft: true` pages live in git. They are excluded from wiki listings and from `generateStaticParams`. Remove `draft` or set `draft: false` when the page is ready to publish.

## How to publish a page

1. **Idea content** — Add or undraft `{slug}.md` under `web/content/wiki/`.
2. **Product docs** — Edit the source in `docs/` or `LICENSE`. Do not copy those files into `web/content/wiki/`.
3. **Render** — `python -m chatticus.wiki_publish` (also `npm run prebuild` / `predev` in `web/`). Pages are Markus HTML with the Chatticus theme (`web/styles/markus-chatticus.css`).
4. **Routes** — `web/app/wiki/[slug]/` is the published wiki. Use the shared factory in `web/lib/wiki-page.tsx`.

The wiki is linked from the footer and is indexable. Do not point marketing copy at GitHub blobs of `docs/*.md` or `LICENSE`; use `/wiki/{slug}`. Source, issues, and IAM YAML stay on GitHub.
