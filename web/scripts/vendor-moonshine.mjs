import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const sourceDirectory = dirname(
  require.resolve("@moonshine-ai/moonshine-wasm/moonshine.wasm", { paths: [webDirectory] }),
);
const { version } = JSON.parse(readFileSync(join(dirname(sourceDirectory), "package.json"), "utf8"));
const vendorRoot = join(webDirectory, "public", "vendor", "moonshine");
const targetDirectory = join(vendorRoot, version);

if (!existsSync(join(targetDirectory, "moonshine.wasm"))) {
  rmSync(vendorRoot, { recursive: true, force: true });
  cpSync(sourceDirectory, targetDirectory, {
    recursive: true,
    filter: (path) => !path.endsWith(".map") && !path.endsWith(".d.ts"),
  });
}
console.log(`[vendor-moonshine] ${version} -> public/vendor/moonshine/${version}`);
