import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(__dirname, "results");
const harnessDir = path.join(__dirname, "harness");

const directUrl = process.env.SSE_SPIKE_DIRECT_URL;
const cloudFrontUrl = process.env.SSE_SPIKE_CLOUDFRONT_URL;

if (!directUrl || !cloudFrontUrl) {
  console.error(
    "Set SSE_SPIKE_DIRECT_URL and SSE_SPIKE_CLOUDFRONT_URL from CDK outputs before running.",
  );
  process.exit(1);
}

const shortDurationSeconds = Number(process.env.SSE_SPIKE_SHORT_DURATION_SECONDS ?? 60);
const reconnectDurationSeconds = Number(process.env.SSE_SPIKE_RECONNECT_DURATION_SECONDS ?? 45);
const reconnectAfterFrames = Number(process.env.SSE_SPIKE_RECONNECT_AFTER_FRAMES ?? 20);
const longDurationSeconds = Number(process.env.SSE_SPIKE_LONG_DURATION_SECONDS ?? 120);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function startHarnessServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const requestPath = request.url === "/" ? "/index.html" : request.url ?? "/index.html";
      const filePath = path.join(harnessDir, requestPath);
      const extension = path.extname(filePath);
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.writeHead(200, { "Content-Type": contentTypes[extension] ?? "text/plain" });
      response.end(readFileSync(filePath));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to start harness server");
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function runScenario(page, harnessBaseUrl, scenario) {
  await page.goto(`${harnessBaseUrl}/index.html`);
  await page.fill("#direct-url", directUrl);
  await page.fill("#cloudfront-url", cloudFrontUrl);
  await page.fill("#duration-seconds", String(scenario.durationSeconds));
  await page.fill("#reconnect-after", String(scenario.reconnectAfterFrames ?? 0));

  if (scenario.hiddenDocumentMock) {
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get() {
          return true;
        },
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  await page.click(scenario.buttonId);
  await page.waitForFunction(
    (expectedPath) =>
      window.__chatticusHarness?.latestSummary &&
      window.__chatticusHarness.latestSummary.path === expectedPath,
    scenario.expectedPath,
    { timeout: (scenario.durationSeconds + 30) * 1000 },
  );

  const summary = await page.evaluate(() => window.__chatticusHarness.latestSummary);
  summary.scenario = scenario.name;
  summary.measured_at = new Date().toISOString();
  return summary;
}

async function main() {
  await mkdir(resultsDir, { recursive: true });

  const { server, baseUrl } = await startHarnessServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const scenarios = [
    {
      name: "direct_foreground_short",
      buttonId: "#run-direct",
      expectedPath: "direct",
      durationSeconds: shortDurationSeconds,
      backgrounded: false,
    },
    {
      name: "cloudfront_foreground_short",
      buttonId: "#run-cloudfront",
      expectedPath: "cloudfront",
      durationSeconds: shortDurationSeconds,
      backgrounded: false,
    },
    {
      name: "direct_hidden_document_mock_short",
      buttonId: "#run-direct",
      expectedPath: "direct",
      durationSeconds: shortDurationSeconds,
      hiddenDocumentMock: true,
    },
    {
      name: "cloudfront_hidden_document_mock_short",
      buttonId: "#run-cloudfront",
      expectedPath: "cloudfront",
      durationSeconds: shortDurationSeconds,
      hiddenDocumentMock: true,
    },
    {
      name: "direct_reconnect",
      buttonId: "#run-reconnect-direct",
      expectedPath: "direct_reconnect",
      durationSeconds: reconnectDurationSeconds,
      reconnectAfterFrames,
      backgrounded: false,
    },
    {
      name: "cloudfront_reconnect",
      buttonId: "#run-reconnect-cloudfront",
      expectedPath: "cloudfront_reconnect",
      durationSeconds: reconnectDurationSeconds,
      reconnectAfterFrames,
      backgrounded: false,
    },
    {
      name: "direct_foreground_long",
      buttonId: "#run-direct",
      expectedPath: "direct",
      durationSeconds: longDurationSeconds,
      backgrounded: false,
    },
    {
      name: "cloudfront_foreground_long",
      buttonId: "#run-cloudfront",
      expectedPath: "cloudfront",
      durationSeconds: longDurationSeconds,
      backgrounded: false,
    },
  ];

  const allResults = {
    measured_at: new Date().toISOString(),
    direct_url: directUrl,
    cloudfront_url: cloudFrontUrl,
    scenarios: [],
  };

  for (const scenario of scenarios) {
    console.log(`Running ${scenario.name}...`);
    const summary = await runScenario(page, baseUrl, scenario);
    const outputPath = path.join(resultsDir, `${scenario.name}.json`);
    await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
    allResults.scenarios.push({
      name: scenario.name,
      path: summary.path,
      frame_count: summary.frame_count,
      duration_ms: summary.duration_ms,
      first_byte_ms: summary.first_byte_ms,
      inter_frame_gap_ms: summary.inter_frame_gap_ms,
      batching: summary.batching,
      reconnect_result: summary.reconnect_result,
      close_reason: summary.close_reason,
      hidden_document_mock: summary.hidden_document_mock ?? false,
      output_file: path.basename(outputPath),
    });
    console.log(`Wrote ${outputPath}`);
  }

  const summaryPath = path.join(resultsDir, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(allResults, null, 2)}\n`);
  console.log(`Wrote ${summaryPath}`);

  await browser.close();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
