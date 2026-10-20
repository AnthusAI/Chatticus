import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

const ACCEPTANCE_PLUGIN_MODULE = `
class AcceptanceNotePanel extends HTMLElement {
  set chatticus(binding) {
    this.binding = binding;
    this.textContent = "size=" + binding.context.size + " active=" + binding.context.active + " theme=" + binding.context.theme;
    if (!this.titled) {
      this.titled = true;
      binding.host.setTitle("Acceptance notes");
      binding.host.setStatus({ label: "3", tone: "attention" });
    }
  }
  get chatticus() { return this.binding; }
}
customElements.define("acceptance-note-panel", AcceptanceNotePanel);
`;

/** Exercise the real workspace in Chrome; lifecycle events model Safari recovery, not a physical iPad keyboard. */
async function main(): Promise<void> {
  const input = JSON.parse(process.argv[2] ?? "{}");
  const webDirectory = fileURLToPath(new URL("..", import.meta.url));
  process.chdir(webDirectory);
  const profileDirectory = await mkdtemp(join(tmpdir(), "chatticus-layout-browser-"));
  const chromeExecutable = process.env.CHATTICUS_TEST_CHROME_PATH
    ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
  const bundle = await build({
    entryPoints: [join(webDirectory, "test-support/workspace-browser-fixture.tsx")],
    bundle: true,
    write: false,
    platform: "browser",
    jsx: "automatic",
    tsconfig: join(webDirectory, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    loader: { ".wasm": "dataurl", ".css": "empty" },
  });
  const globalCss = (await readFile(join(webDirectory, "app/globals.css"), "utf8"))
    .replace('@import "../styles/shared.css";', await readFile(join(webDirectory, "styles/shared.css"), "utf8"));
  const css = await postcss([tailwindcss({ config: join(webDirectory, "tailwind.config.ts") })])
    .process(globalCss, { from: join(webDirectory, "app/globals.css") });
  const server = createServer((request, response) => {
    if (request.url === "/acceptance-plugin.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(ACCEPTANCE_PLUGIN_MODULE);
    } else if (request.url === "/fixture.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = spawn(chromeExecutable, [
    "--headless=new", "--disable-extensions", "--disable-background-networking", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    ...(process.platform === "linux" ? ["--disable-dev-shm-usage"] : []),
    "--remote-debugging-port=0", `--user-data-dir=${profileDirectory}`, "about:blank",
  ], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let browserStderr = "";
  let browserSpawnError: Error | undefined;
  browser.stderr.on("data", (chunk) => { browserStderr = (browserStderr + String(chunk)).slice(-8_000); });
  browser.on("error", (error) => { browserSpawnError = error; });
  let socket: WebSocket | undefined;
  let nextCommandId = 0;
  let pageLoadCount = 0;
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  async function command(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++nextCommandId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Chrome command timed out: ${method}`));
      }, 10_000);
      pending.set(id, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      socket!.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression: string): Promise<any> {
    const response = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  async function until(expression: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await delay(30);
    }
    throw new Error(`Browser condition did not become true: ${expression}`);
  }
  async function viewport(width: number, height: number): Promise<void> {
    await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }
  const selector = (column: string) => `[role="separator"][aria-label="Resize ${column}"]`;
  const columnSelector = (column: string) => column === "sidebar" ? ".workspace-roster" : ".workspace-panel";
  async function width(column: string): Promise<number> {
    return evaluate(`document.querySelector('${columnSelector(column)}').getBoundingClientRect().width`);
  }
  async function key(column: string, keyName: string): Promise<void> {
    await evaluate(`document.querySelector('${selector(column)}').focus()`);
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: keyName });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: keyName });
    await delay(50);
  }
  async function reload(): Promise<void> {
    const previousLoadCount = pageLoadCount;
    await command("Page.reload");
    for (let attempt = 0; pageLoadCount === previousLoadCount && attempt < 100; attempt++) await delay(30);
    assert.ok(pageLoadCount > previousLoadCount, "Reload did not finish");
    await until(`document.querySelector('.workspace-shell') && document.querySelector('[aria-label="Resize sidebar"]') && document.documentElement.style.getPropertyValue('--workspace-viewport-height') !== ''`);
    await delay(100);
  }
  async function point(column: string): Promise<{ x: number; y: number }> {
    return evaluate(`(() => { const r = document.querySelector('${selector(column)}').getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + 40}; })()`);
  }
  async function clickAt(point: { x: number; y: number }, clickCount: number): Promise<void> {
    await command("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount });
    await command("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount });
  }
  try {
    const portFile = join(profileDirectory, "DevToolsActivePort");
    const startupDeadline = Date.now() + 25_000;
    let debuggingPort: string | undefined;
    while (Date.now() < startupDeadline) {
      if (browserSpawnError) throw new Error(`Cannot start Chrome executable ${chromeExecutable}: ${browserSpawnError.message}`);
      if (browser.exitCode !== null || browser.signalCode !== null) {
        throw new Error(`Chrome exited before becoming ready: code=${browser.exitCode}, signal=${browser.signalCode}`);
      }
      try {
        const [port] = (await readFile(portFile, "utf8")).split("\n");
        if (/^\d+$/.test(port)) { debuggingPort = port; break; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(50);
    }
    assert.ok(debuggingPort, "Chrome did not publish DevToolsActivePort within 25 seconds");
    const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`, { signal: AbortSignal.timeout(10_000) })).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    socket = new WebSocket(targets.find((target) => target.type === "page")!.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Chrome debugging connection timed out")), 10_000);
      socket!.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket!.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Cannot connect to headless Chrome")); }, { once: true });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Page.loadEventFired") pageLoadCount++;
      if (message.method === "Runtime.exceptionThrown") console.error(JSON.stringify(message.params.exceptionDetails));
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
      else waiting.resolve(message.result);
    });
    await command("Page.enable");
    await command("Runtime.enable");
    await viewport(2000, 900);
    await command("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
    await until(`document.querySelector('.workspace-shell') !== null`);
    let output: unknown;
    if (input.action === "viewport") {
      await viewport(1366, 480);
      await until(`document.querySelector('.workspace-shell').getBoundingClientRect().height === 480`);
      if (input.event === "resize") {
        await viewport(1366, 900);
      } else {
        await evaluate(`Object.defineProperty(window, 'innerHeight', {configurable: true, value: 620});
          ${input.event === "visualViewport" ? "window.visualViewport" : "window"}.dispatchEvent(new Event('${input.event === "visualViewport" ? "resize" : input.event}'))`);
        await until(`document.querySelector('.workspace-shell').getBoundingClientRect().height === 620`);
        await evaluate(`Object.defineProperty(window, 'innerHeight', {configurable: true, value: 900}); void 0`);
        await delay(600);
        await until(`document.querySelector('.workspace-shell').getBoundingClientRect().height === 900`);
        await viewport(1366, 900);
      }
      await until(`document.querySelector('.workspace-shell').getBoundingClientRect().height === window.innerHeight`);
      output = await evaluate(`({height: document.querySelector('.workspace-shell').getBoundingClientRect().height, viewportHeight: window.innerHeight, documentHeight: document.documentElement.scrollHeight})`);
    } else if (input.action === "columns") {
      const column = input.column;
      const defaultWidth = await width(column);
      const start = await point(column);
      const movement = column === "sidebar" ? 80 : -80;
      await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
      await command("Input.dispatchMouseEvent", { type: "mousePressed", ...start, button: "left", clickCount: 1 });
      await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x + movement, y: start.y, button: "left", buttons: 1 });
      await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: start.x + movement, y: start.y, button: "left", clickCount: 1 });
      await until(`Math.abs(document.querySelector('${columnSelector(column)}').getBoundingClientRect().width - ${defaultWidth + 80}) < 1`);
      const draggedWidth = await width(column);
      await reload();
      const restoredWidth = await width(column);
      await key(column, column === "sidebar" ? "ArrowRight" : "ArrowLeft");
      const widerWidth = await width(column);
      await key(column, column === "sidebar" ? "ArrowLeft" : "ArrowRight");
      const narrowerWidth = await width(column);
      await key(column, "Home");
      const minimumWidth = await width(column);
      await key(column, column === "sidebar" ? "ArrowLeft" : "ArrowRight");
      const belowMinimumWidth = await width(column);
      await key(column, "End");
      const maximumWidth = await width(column);
      await key(column, column === "sidebar" ? "ArrowRight" : "ArrowLeft");
      const aboveMaximumWidth = await width(column);
      await clickAt(await point(column), 2);
      await until(`!document.querySelector('.workspace-shell').classList.contains('workspace-shell--${column === "sidebar" ? "roster" : "panel"}-resized')`);
      const resetWidth = await width(column);
      await reload();
      output = { column, defaultWidth, draggedWidth, restoredWidth, widerWidth, narrowerWidth, minimumWidth, belowMinimumWidth, maximumWidth, aboveMaximumWidth, resetWidth, resetReloadWidth: await width(column), storedWidth: await evaluate(`localStorage.getItem('chatticus.workspace.${column === "sidebar" ? "roster" : "panel"}WidthPixels')`) };
    } else if (input.action === "clamping") {
      await key("sidebar", "End");
      await key("panel", "End");
      await reload();
      const saved = { sidebar: await width("sidebar"), panel: await width("panel") };
      await viewport(1280, 900);
      await delay(100);
      const narrow = await evaluate(`({sidebar: document.querySelector('.workspace-roster').getBoundingClientRect().width, panel: document.querySelector('.workspace-panel').getBoundingClientRect().width, conversation: document.querySelector('[aria-label="Conversation"]').getBoundingClientRect().width, documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth})`);
      await viewport(2000, 900);
      await delay(100);
      output = { saved, narrow, restored: { sidebar: await width("sidebar"), panel: await width("panel") } };
    } else if (input.action === "plugins") {
      await until(`document.querySelector('chatticus-context-panel') !== null`);
      const contextPanelRendered = await evaluate(`document.querySelector('chatticus-context-panel').textContent.includes('Computer')`);
      await evaluate(`document.querySelector('[role="tab"]:nth-child(2)').click()`);
      await until(`document.querySelector('chatticus-files-panel') !== null`);
      const registration = await evaluate(`window.registerAcceptancePanelPlugin({
        id: "acceptance-notes", name: "Notes", version: "1.0.0", entry: "/acceptance-plugin.js",
        elements: { panel: "acceptance-note-panel" }, sizes: ["split", "full"], handles: ["acceptance.note"],
      })`);
      await until(`[...document.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent.includes('Notes'))`);
      const tabNamesBeforeOpening = await evaluate(`[...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)`);
      await evaluate(`[...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.includes('Notes')).click()`);
      await until(`document.querySelector('acceptance-note-panel') !== null && document.querySelector('acceptance-note-panel').textContent !== ''`);
      await until(`[...document.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent.includes('Acceptance notes'))`);
      const splitContent = await evaluate(`document.querySelector('acceptance-note-panel').textContent`);
      await evaluate(`[...document.querySelectorAll('[aria-label="Panel size"] button')].find((button) => button.textContent === 'Full').click()`);
      await until(`document.querySelector('acceptance-note-panel').textContent.includes('size=full')`);
      const fullContent = await evaluate(`document.querySelector('acceptance-note-panel').textContent`);
      const tabTitlesAfterOpening = await evaluate(`[...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)`);
      await evaluate(`[...document.querySelectorAll('[role="tab"]')][0].click()`);
      await until(`document.querySelector('acceptance-note-panel').closest('[role="tabpanel"]').hidden`);
      const keptMountedWhileHidden = await evaluate(`document.querySelector('acceptance-note-panel').textContent.includes('active=false')`);
      const reservedCoreRegistration = await evaluate(`window.registerAcceptancePanelPlugin({
        id: "files", name: "Impostor", version: "1.0.0", elements: { panel: "impostor-panel" }, sizes: ["split"],
      })`);
      const failingRegistration = await evaluate(`window.registerAcceptancePanelPlugin({
        id: "missing-module", name: "Missing", version: "1.0.0", entry: "/does-not-exist.js", elements: { panel: "missing-module-panel" }, sizes: ["split"],
      })`);
      await until(`[...document.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent.includes('Missing'))`);
      await evaluate(`[...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.includes('Missing')).click()`);
      const failureAlert = `[...document.querySelectorAll('[role="alert"]')].find((alert) => alert.textContent.includes('could not be loaded'))`;
      await until(`${failureAlert} !== undefined`);
      output = {
        contextPanelRendered, registration, fullContent, tabNamesBeforeOpening, splitContent, tabTitlesAfterOpening, keptMountedWhileHidden,
        reservedCoreRegistration, failingRegistration, failureMessage: await evaluate(`${failureAlert}.textContent`),
      };
    } else throw new Error(`Unknown browser action ${input.action}`);
    process.stdout.write(JSON.stringify(output));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nChrome stderr: ${browserStderr || "(empty)"}`);
  } finally {
    socket?.close();
    const signalBrowserGroup = (signal: NodeJS.Signals) => {
      if (!browser.pid) return;
      try {
        process.kill(-browser.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const closed = browser.exitCode !== null || browser.signalCode !== null || !browser.pid
      ? Promise.resolve()
      : new Promise<void>((resolve) => browser.once("exit", () => resolve()));
    signalBrowserGroup("SIGTERM");
    await Promise.race([closed, delay(2000)]);
    signalBrowserGroup("SIGKILL");
    browser.stderr.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profileDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

}

main().catch((error) => { console.error(error); process.exitCode = 1; });
