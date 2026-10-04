// Build the Pages site into site/dist: `pnpm bar:web`'s page and font, with a
// transport (site/transport.ts) that runs the daemon's own modules in the page
// over a simulated Node (site/shims).
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readFileSync } from "node:fs";
const here = path.dirname(fileURLToPath(import.meta.url));
const shim = (f) => path.join(here, "shims", f);
const alias = {};
for (const [mods, file] of [
  [["fs"], "fs.ts"],
  [["fs/promises"], "fs-promises.ts"],
  [["os"], "os.ts"],
  [["url"], "url.ts"],
  [["util"], "util.ts"],
  [["timers/promises"], "timers-promises.ts"],
  [["crypto"], "crypto.ts"],
  [["process"], "process.ts"],
  [["child_process"], "child_process.ts"],
  [["net", "https", "http", "readline", "module", "stream/consumers", "v8", "worker_threads", "tty"], "unavailable.ts"],
]) for (const m of mods) { alias[m] = shim(file); alias[`node:${m}`] = shim(file); }
alias.path = alias["node:path"] = "path-browserify";
alias.events = alias["node:events"] = "events";
alias.stream = alias["node:stream"] = "readable-stream";
alias.buffer = alias["node:buffer"] = "buffer";
alias.timers = alias["node:timers"] = shim("timers.ts");

const dist = path.join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const page = path.join(here, "..", "scripts", "bar-web");
for (const f of ["index.html", "rich-powerline.woff2", "FONT-LICENSE"]) copyFileSync(path.join(page, f), path.join(dist, f));

const result = await build({
  entryPoints: [path.join(here, "transport.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: path.join(dist, "transport.js"),
  alias,
  inject: [shim("globals.ts")],
  define: { global: "globalThis", "import.meta.url": JSON.stringify("file:///app/dist/index.mjs"), __SOURCE_DIGEST__: "undefined",
    __PACKAGE_VERSION__: JSON.stringify(JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version) },
  logLevel: "warning",
  metafile: true,
  sourcemap: true,
});
const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`built site/dist (transport.js (${(bytes / 1e6).toFixed(1)} MB with map)`);
