import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const spikeDirectory = fileURLToPath(new URL(".", import.meta.url));
const packageDistDirectory = join(spikeDirectory, "node_modules/@moonshine-ai/moonshine-wasm/dist");
const port = Number(process.env.VOICE_SPIKE_PORT ?? 4173);
const crossOriginEmbedderPolicy = process.env.VOICE_SPIKE_COEP ?? "require-corp";
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".ort": "application/octet-stream",
  ".bin": "application/octet-stream",
};

function resolveRequestPath(urlPath) {
  if (urlPath.startsWith("/pkg/")) {
    return join(packageDistDirectory, normalize(urlPath.slice("/pkg/".length)));
  }
  const relativePath = urlPath === "/" ? "page/index.html" : normalize(urlPath.slice(1));
  return join(spikeDirectory, relativePath);
}

createServer((request, response) => {
  const urlPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const filePath = resolveRequestPath(urlPath);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (crossOriginEmbedderPolicy !== "none") {
    response.setHeader("Cross-Origin-Embedder-Policy", crossOriginEmbedderPolicy);
  }
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (!filePath.startsWith(spikeDirectory) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    response.writeHead(404).end("not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    "Content-Length": statSync(filePath).size,
  });
  createReadStream(filePath).pipe(response);
}).listen(port, () => {
  console.log(`voice spike on http://localhost:${port} (COEP ${crossOriginEmbedderPolicy})`);
});
