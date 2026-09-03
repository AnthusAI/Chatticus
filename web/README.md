# Chatticus web

Next.js app for **marketing** at `/` and the **product workspace** at `/chat`.
Production export goes to `out/` for the `ChatticusWeb` CloudFront stack; same-origin
`/api` is stripped at the edge in deployed environments.

From the repo root, `npm install` installs all JavaScript dependencies (canonical).
You can still `cd web` and run scripts below.

```bash
npm install
npm test
npm run lint
npm run typecheck
npm run build
```

## Local development

`npm run dev` serves the marketing and product routes on port 3000. API calls use
same-origin `/api` (see `lib/config.ts`). To proxy those requests to a named stack,
set one of these in `.env.local`:

```bash
CHATTICUS_DEVELOPMENT_BASE_URL=https://dev.chattic.us/api
# or
CHATTICUS_DEV_API_ORIGIN=https://dev.chattic.us/api
```

Without either variable, `/api` is not rewritten and you need another way to reach
the ThinTurn front door (for example, sign in on https://dev.chattic.us).

Google sign-in uses Cognito values from the deployed `ChatticusAuth` stack; see the
root [README](../README.md) and [infra/README](../infra/README.md).
