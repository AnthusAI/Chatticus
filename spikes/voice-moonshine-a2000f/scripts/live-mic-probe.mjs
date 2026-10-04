import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
const fixture = new URL("../fixtures/utterances.wav", import.meta.url).pathname;
const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fixture}`, "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
page.on("pageerror", (error) => console.log("pageerror", String(error)));
await page.goto("http://localhost:4173/");
await page.click("#start");
page.on("console", (message) => console.log("console", message.type(), message.text().slice(0, 200)));
for (let i = 0; i < 12; i += 1) {
  await sleep(5000);
  const status = await page.textContent("#status");
  console.log("status:", status);
  if (status.startsWith("Listening") || status.includes("rror") || status.startsWith("Could not")) break;
}
console.log(await page.textContent("#status"));
await sleep(80000);
const rows = await page.$$eval("#lines li", (items) => items.reverse().map((item) => `${item.querySelector(".tag").textContent.padEnd(14)} ${item.querySelector(".heard").textContent}`));
console.log(rows.join("\n"));
await browser.close();
