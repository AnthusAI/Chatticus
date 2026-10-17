import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";

import { chromium, type Browser, type BrowserContext } from "playwright";

import {
  REVIEW_COLOR_SCHEMES,
  REVIEW_SCREENS,
  REVIEW_VIEWPORTS,
  reviewShotFileName,
  type ReviewColorScheme,
  type ReviewScreen,
  type ReviewViewport,
} from "./review-screenshot-screens";
import {
  REVIEW_SCREENSHOT_FIXED_TIME,
  REVIEW_SCREENSHOT_USER_EMAIL,
  REVIEW_SCREENSHOT_USER_ID,
  ReviewScreenshotWorkspace,
} from "./review-screenshot-workspace";

/**
 * Serves a static export of the web app on localhost, signs a fake member in, answers every API call from the
 * seeded review workspace, and shoots each review screen at each viewport and color scheme. The export must be
 * built with the REVIEW_SCREENSHOT_COGNITO_* values below so the fake session passes the app's claim checks.
 * Nothing leaves the machine: Cognito and every other outside host is refused.
 */

export const REVIEW_SCREENSHOT_COGNITO_USER_POOL_ID = "us-east-1_ReviewShots";
export const REVIEW_SCREENSHOT_COGNITO_CLIENT_ID = "review-screenshots";

const REVIEW_SCREENSHOT_AUTHORITY = `https://cognito-idp.us-east-1.amazonaws.com/${REVIEW_SCREENSHOT_COGNITO_USER_POOL_ID}`;
const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const SETTLE_AFTER_ARRANGE_MILLISECONDS = 600;

const contentTypeByExtension: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
};

export type CapturedShot = {
  fileName: string;
  screenId: string;
  screenLabel: string;
  viewportId: string;
  viewportLabel: string;
  colorScheme: ReviewColorScheme;
};

export type CaptureManifest = {
  shots: CapturedShot[];
  skipped: Array<{ screenId: string; viewportId: string; colorScheme: ReviewColorScheme; reason: string }>;
  unansweredRoutes: string[];
  pageErrors: string[];
};

function fileForRequestPath(siteDirectory: string, requestPath: string): string | null {
  const decodedPath = decodeURIComponent(requestPath.split("?")[0]);
  const candidatePath = normalize(join(siteDirectory, decodedPath));
  if (!candidatePath.startsWith(siteDirectory)) return null;
  const candidates = decodedPath.endsWith("/")
    ? [join(candidatePath, "index.html")]
    : [candidatePath, `${candidatePath}.html`, join(candidatePath, "index.html")];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function serveStaticExport(siteDirectory: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const requestPath = request.url ?? "/";
    if (requestPath === "/" || requestPath.startsWith("/?")) {
      response.writeHead(302, { location: "/chat/" });
      response.end();
      return;
    }
    const filePath = fileForRequestPath(siteDirectory, requestPath);
    if (filePath === null) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": contentTypeByExtension[extname(filePath)] ?? "application/octet-stream" });
    createReadStream(filePath).pipe(response);
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function base64UrlOfJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeStoredOidcUser(): { storageKey: string; storageValue: string } {
  const issuedAtSeconds = Math.floor(Date.parse(REVIEW_SCREENSHOT_FIXED_TIME) / 1000);
  const expiresAtSeconds = issuedAtSeconds + SESSION_LIFETIME_SECONDS;
  const claims = {
    token_use: "id",
    iss: REVIEW_SCREENSHOT_AUTHORITY,
    aud: REVIEW_SCREENSHOT_COGNITO_CLIENT_ID,
    sub: REVIEW_SCREENSHOT_USER_ID,
    email: REVIEW_SCREENSHOT_USER_EMAIL,
    iat: issuedAtSeconds,
    exp: expiresAtSeconds,
  };
  const idToken = `${base64UrlOfJson({ alg: "none", typ: "JWT" })}.${base64UrlOfJson(claims)}.review-screenshots`;
  return {
    storageKey: `oidc.user:${REVIEW_SCREENSHOT_AUTHORITY}:${REVIEW_SCREENSHOT_COGNITO_CLIENT_ID}`,
    storageValue: JSON.stringify({
      id_token: idToken,
      access_token: idToken,
      token_type: "Bearer",
      scope: "openid email profile",
      profile: claims,
      expires_at: expiresAtSeconds,
    }),
  };
}

async function openReviewContext(
  browser: Browser,
  origin: string,
  viewport: ReviewViewport,
  colorScheme: ReviewColorScheme,
  screen: ReviewScreen,
  workspace: ReviewScreenshotWorkspace,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    isMobile: viewport.isMobile,
    hasTouch: viewport.isMobile,
    colorScheme,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  if (screen.signedIn) {
    const { storageKey, storageValue } = fakeStoredOidcUser();
    await context.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key, value);
      },
      [storageKey, storageValue] as const,
    );
  }
  await context.route("**/*", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (requestUrl.origin !== origin) {
      await route.abort("blockedbyclient");
      return;
    }
    if (!requestUrl.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    const answer = await workspace.answer({
      url: request.url(),
      method: request.method(),
      headers: await request.allHeaders(),
      body: request.postData(),
    });
    await route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
  });
  return context;
}

async function captureReviewScreenshots(siteDirectory: string, outputDirectory: string): Promise<CaptureManifest> {
  mkdirSync(outputDirectory, { recursive: true });
  const workspace = new ReviewScreenshotWorkspace();
  const manifest: CaptureManifest = { shots: [], skipped: [], unansweredRoutes: [], pageErrors: [] };
  const { server, origin } = await serveStaticExport(siteDirectory);
  const browser = await chromium.launch();
  try {
    for (const screen of REVIEW_SCREENS) {
      for (const viewport of REVIEW_VIEWPORTS) {
        for (const colorScheme of REVIEW_COLOR_SCHEMES) {
          const context = await openReviewContext(browser, origin, viewport, colorScheme, screen, workspace);
          const page = await context.newPage();
          page.on("pageerror", (error) => manifest.pageErrors.push(`${screen.id} ${viewport.id}: ${error.message}`));
          await page.clock.setFixedTime(new Date(REVIEW_SCREENSHOT_FIXED_TIME));
          try {
            await page.goto(`${origin}/chat/`, { waitUntil: "networkidle" });
            const screenExists = await screen.arrange(page);
            if (!screenExists) {
              manifest.skipped.push({ screenId: screen.id, viewportId: viewport.id, colorScheme, reason: "not shown at this size" });
              continue;
            }
            await page.waitForLoadState("networkidle");
            await page.waitForTimeout(SETTLE_AFTER_ARRANGE_MILLISECONDS);
            const fileName = reviewShotFileName(screen.id, viewport.id, colorScheme);
            await page.screenshot({ path: join(outputDirectory, fileName), animations: "disabled", caret: "hide" });
            manifest.shots.push({
              fileName,
              screenId: screen.id,
              screenLabel: screen.label,
              viewportId: viewport.id,
              viewportLabel: viewport.label,
              colorScheme,
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
            manifest.skipped.push({ screenId: screen.id, viewportId: viewport.id, colorScheme, reason });
            await page.screenshot({ path: join(outputDirectory, `failed--${reviewShotFileName(screen.id, viewport.id, colorScheme)}`) }).catch(() => undefined);
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  manifest.unansweredRoutes = [...new Set([...workspace.unansweredRoutes, ...workspace.files.otherRequests])];
  writeFileSync(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      site: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.site || !values.output) {
    throw new Error("Usage: capture-review-screenshots --site <static export directory> --output <shot directory>");
  }
  const manifest = await captureReviewScreenshots(resolve(values.site), resolve(values.output));
  console.log(`Captured ${manifest.shots.length} shots, skipped ${manifest.skipped.length}.`);
  for (const skipped of manifest.skipped) console.log(`skipped ${skipped.screenId} ${skipped.viewportId} ${skipped.colorScheme}: ${skipped.reason}`);
  for (const route of manifest.unansweredRoutes) console.log(`unanswered ${route}`);
  for (const pageError of manifest.pageErrors) console.log(`page error ${pageError}`);
  if (manifest.shots.length === 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("capture-review-screenshots.ts")) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
