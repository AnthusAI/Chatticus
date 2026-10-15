import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
const fixture = new URL("../fixtures/utterances.wav", import.meta.url).pathname;
const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fixture}`, "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
page.on("pageerror", (error) => console.log("pageerror", String(error)));
await page.addInitScript(() => {
  const started = performance.now();
  const stamp = (label) => console.log(`[timing] ${((performance.now() - started) / 1000).toFixed(1)}s ${label}`);
  const wrap = (owner, name, label) => {
    const original = owner[name];
    owner[name] = async function (...args) {
      stamp(`${label} start`);
      try {
        return await original.apply(this, args);
      } finally {
        stamp(`${label} end`);
      }
    };
  };
  wrap(MediaDevices.prototype, "getUserMedia", "getUserMedia");
  wrap(AudioContext.prototype, "resume", "AudioContext.resume");
  wrap(AudioWorklet.prototype, "addModule", "AudioWorklet.addModule");
});
await page.goto("http://localhost:4173/");
await page.click("#start");
page.on("console", (message) => message.text().startsWith("[timing]") && console.log(message.text()));
for (let i = 0; i < 12; i += 1) {
  await sleep(15000);
  const status = await page.textContent("#status");
  console.log("status:", status);
  if (status.startsWith("Listening") || status.includes("rror") || status.startsWith("Could not")) break;
}
console.log(await page.textContent("#status"));
await sleep(15000);
const rows = await page.$$eval("#lines li", (items) => items.reverse().map((item) => `${item.querySelector(".tag").textContent.padEnd(14)} ${item.querySelector(".heard").textContent}`));
console.log(rows.join("\n"));
console.log("diagnostics:", await page.textContent("#diagnostics"));
await browser.close();
