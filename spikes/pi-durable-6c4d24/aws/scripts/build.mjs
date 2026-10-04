import { mkdirSync, statSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("build", { recursive: true });
const common = {
  entryPoints: ["src/handler.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  logLevel: "error",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};
await build({ ...common, outfile: "build/lambda/handler.mjs" });
await build({ ...common, minify: true, outfile: "build/handler.min.mjs" });
await build({ ...common, minify: true, outfile: "build/handler.min-sdk-external.mjs", external: ["@aws-sdk/*"] });
for (const name of ["handler.mjs", "handler.min.mjs", "handler.min-sdk-external.mjs"]) {
  console.log(name, statSync(name === "handler.mjs" ? "build/lambda/handler.mjs" : `build/${name}`).size);
}
