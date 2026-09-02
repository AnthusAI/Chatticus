# Brand guidelines

Visual rules for Chatticus surfaces (marketing site and product workspace).
This governs backgrounds and regions only. It does not change foreground,
text, or accent colors (`ink`, `paper`, `signal`, `clay`, `cobalt`, `sea`,
`amber` stay exactly as they are).

## No lines, no gradients

Regions are never denoted by a border, outline, divider rule, or gradient.
A region is a rounded rectangle with a flat background-color step. Nothing
else marks its edge — no `border`, no `divide-x`/`divide-y`, no `outline`,
no `linear-gradient`/`radial-gradient` standing in for a boundary.

Hard-edge drop shadows (e.g. `shadow-[4px_4px_0_var(--ink)]`) are a
different device — ornament, not a region boundary — and are unaffected by
this rule.

## Three background steps, symmetric across light and dark

Every surface uses exactly three background steps:

| Token | Role |
| --- | --- |
| `surface-0` | Page base |
| `surface-1` | A raised region |
| `surface-2` | The region getting the most attention (e.g. the latest bot message, the active nav item) |

Neither `surface-0` nor its darkest step is pure black or pure white. Light
mode and dark mode are symmetric mirrors of each other: the same three
relative steps, offset from their respective true black/white by the same
amount. Dark mode is real `prefers-color-scheme` support, not a forced
theme — both marketing and the product workspace render correctly in
whichever mode the visitor's system prefers.

`surface-2` is reserved for the single thing on a screen that should draw
the eye most; don't apply it to more than one region in a given view.

## Message-shaped affordances

The logo mark's black bubble (`CHATTICUS_MARK_MODEL` in Vultus) is a
rounded rectangle with three corners fully rounded and one corner sharp
(corner radii 8/8/1.85/8 on its 20x16 box — the sharp corner is roughly
0.23x the rounded ones). Primary actions that represent sending or
receiving a message (e.g. the "Hey, Chatticus..." header CTA) use this
same shape instead of a plain pill, scaled to the control's own height:
round corners at half the height, the sharp corner at ~0.23x that. This is
a deliberate motif, not a rule for every button — most controls (secondary
actions, form buttons, nav) stay pill-shaped (`rounded-full`) or use the
existing hard-edge card style; reach for the message-bubble shape only for
controls that are themselves about a message.
