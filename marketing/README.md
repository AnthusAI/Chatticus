# Chatticus marketing site

Public product landing at **chattic.us**. Static Next.js export deployed by
`ChatticusMarketingWeb` (S3 + CloudFront). No `/api` on this hostname.

The signed-in product app lives at **app.chattic.us** (`web/` + thin-turn API).

```bash
npm ci
npm run build
```
