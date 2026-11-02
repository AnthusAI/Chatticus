import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../../chat/test-support/embedded-chat.tsx", import.meta.url));
const result = await build({ entryPoints: [entry], bundle: true, write: false, outfile: "app.js", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
const server = createServer((request, response) => {
  if (request.url === "/app.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(result.outputFiles.find((file) => file.path.endsWith(".js")).contents);
  } else if (request.url === "/app.css") {
    response.setHeader("Content-Type", "text/css");
    response.end(result.outputFiles.find((file) => file.path.endsWith(".css")).contents);
  } else response.end('<!doctype html><html><head><link rel="stylesheet" href="/app.css"><style>html,body,#root,main{height:100%;margin:0;display:flex;flex-direction:column}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText("Ready", { exact: true }).waitFor();
  const unscopedSelectors = await page.evaluate(() => {
    const selectors = [];
    const inspect = (rules) => { for (const rule of rules) {
      if (rule.selectorText && !rule.selectorText.includes(".chatticus-chat")) selectors.push(rule.selectorText);
      if (rule.cssRules && !(rule instanceof CSSKeyframesRule)) inspect(rule.cssRules);
    } };
    for (const sheet of document.styleSheets) if (sheet.href?.endsWith("/app.css")) inspect(sheet.cssRules);
    return selectors;
  });
  assert.deepEqual(unscopedSelectors, []);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  await page.getByRole("textbox", { name: "Message input" }).fill("Run the editorial check");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByText("Host response received", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Send count").textContent(), "1");
  assert.deepEqual(errors, []);
  console.log("Standalone chat send passed\nNo product dependencies");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
