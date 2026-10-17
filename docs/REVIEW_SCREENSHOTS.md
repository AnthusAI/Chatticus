# Review screenshots

Every pull request that touches `web/`, `host-protocol/` or the lockfile gets a comment with screenshots of the
workspace, so a change can be reviewed from a phone or a tablet before it merges and deploys to development.

## What the comment shows

- The screens that differ from the base branch, side by side with the base branch's version.
- A grid of every screen in light mode at desktop (1440x900), iPad landscape (1180x820), iPad portrait (820x1180)
  and phone (390x844) sizes, with dark mode folded underneath.
- Notes from the run when a screen could not be taken or the app called an API route the fake does not answer.

The job only reports. It never blocks a merge, because a visual change is often the point of the pull request.

## How it works

`.github/workflows/review-screenshots.yml` builds the static export of the pull request and of its base commit
with placeholder Cognito settings, then runs `web/test-support/review-screenshots/capture-review-screenshots.ts`
against each export. That script serves the export on localhost, stores a fake signed-in session where
oidc-client-ts reads it, answers every `/api` call from the seeded organization in
`review-screenshot-workspace.ts` (which reuses the cost and file fakes of the web tests), refuses every other host,
and freezes the clock. Nothing in the deployed bundles changes: the fake lives only in `test-support/`.

`compare-review-screenshots.ts` diffs the two sets pixel by pixel, `write-review-screenshot-comment.ts` writes the
comment, and the workflow pushes the images to the `review-screenshots` branch so they render in GitHub's app and
browser for anyone with repository access. Each run replaces that pull request's folder on the branch.

## Adding a screen

Add an entry to `REVIEW_SCREENS` in `review-screenshot-screens.ts`. Its `arrange` function puts the page in the
state to shoot and returns false when the screen does not exist at a viewport. When the screen needs data the
workspace does not have yet, seed it in `review-screenshot-workspace.ts`.

To run it locally, build the export with the `NEXT_PUBLIC_*` values from the workflow, then:

```bash
cd web
npx playwright install chromium
npx tsx test-support/review-screenshots/capture-review-screenshots.ts --site out --output /tmp/review-shots
```
