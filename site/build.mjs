// Build the Pages site into site/dist (or the directory given as the first argument):
// `pnpm bar:web`'s page and font, with a
// transport (site/transport.ts) that runs the daemon's own modules in the page
// over a simulated Node (site/shims).
import { build, context } from "esbuild";
import { landscapeDir } from "./landscape-dir.mjs";
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
alias.string_decoder = alias["node:string_decoder"] = "string_decoder";
alias.timers = alias["node:timers"] = shim("timers.ts");

// `--serve` watches the sources and serves the page, reloading it on every rebuild.
const args = process.argv.slice(2);
const serving = args.includes("--serve");
// The output directory: site/dist, or the one named as the first positional argument (the test builds into its own).
const dist = path.resolve(args.find((a) => a !== "--serve") ?? path.join(here, "dist"));
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const page = path.join(here, "..", "scripts", "bar-web");
for (const f of ["index.html", "rich-powerline.woff2", "FONT-LICENSE"]) copyFileSync(path.join(page, f), path.join(dist, f));

const explorer = landscapeDir();
const landscape = explorer === null ? null : explorer + "/";

const options = {
  entryPoints: [path.join(here, "transport.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: path.join(dist, "transport.js"),
  alias,
  inject: [shim("globals.ts")],
  define: { global: "globalThis", __SOURCE_DIGEST__: "undefined",
    __LANDSCAPE__: JSON.stringify(landscape),
    __PACKAGE_VERSION__: JSON.stringify(JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version) },
  logLevel: "warning",
  metafile: true,
  sourcemap: true,
};
if (serving) {
  const ctx = await context({
    ...options,
    banner: { js: `new EventSource("/esbuild").addEventListener("change", () => location.reload());` },
  });
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: dist, port: 8931 });
  console.log(`serving http://localhost:${port}/`);
  await new Promise(() => {});
}
const result = await build(options);
const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`built ${path.relative(process.cwd(), dist)} (transport.js (${(bytes / 1e6).toFixed(1)} MB with map)`);
