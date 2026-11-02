// Build the Pages site into site/dist (or the directory given as the first argument):
// `pnpm bar:web`'s page and font, with a
// transport (site/transport.ts) that runs the daemon's own modules in the page
// over a simulated Node (site/shims).
import { context } from "esbuild";
import { landscapeDir } from "./landscape-dir.mjs";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

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

// `--serve` watches the sources and serves the page on loopback, reloading it on every rebuild;
// `--port` picks the port (0 for any free one). Any other flag is refused.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { serve: { type: "boolean", default: false }, port: { type: "string" } },
});
const serving = values.serve;
if (positionals.length > 1) throw new Error(`one output directory at most, not ${positionals.length}: ${positionals.join(" ")}`);
if (values.port !== undefined && !serving) throw new Error("--port is the dev server's: use it with --serve");
const portText = values.port ?? "8931";
if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535) throw new Error(`--port must be a port number, not "${portText}"`);
const port = Number(portText);
// The output directory: site/dist, or the one named as the first positional argument (the test builds into its own).
const dist = path.resolve(positionals[0] ?? path.join(here, "dist"));
rmSync(dist, { recursive: true, force: true });
const page = path.join(here, "..", "scripts", "bar-web");

const explorer = landscapeDir();
const landscape = explorer === null ? null : explorer + "/";

const ctx = await context({
  entryPoints: {
    transport: path.join(here, "transport.ts"),
    // The page and its font are entry points copied as they are, so the watch sees an edit to them as it sees one to the sources.
    index: path.join(page, "index.html"),
    "rich-powerline": path.join(page, "rich-powerline.woff2"),
    "FONT-LICENSE": path.join(page, "FONT-LICENSE"),
  },
  loader: { ".html": "copy", ".woff2": "copy", "": "copy" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: dist,
  banner: { js: serving ? `new EventSource("/esbuild").addEventListener("change", () => location.reload());` : "" },
  alias,
  inject: [shim("globals.ts")],
  define: { global: "globalThis", __SOURCE_DIGEST__: "undefined",
    __LANDSCAPE__: JSON.stringify(landscape),
    __PACKAGE_VERSION__: JSON.stringify(JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version) },
  logLevel: "warning",
  metafile: true,
  sourcemap: true,
});
if (serving) {
  await ctx.watch();
  const served = await ctx.serve({ servedir: dist, host: "127.0.0.1", port });
  console.log(`serving ${served.hosts.map((host) => `http://${host}:${served.port}/`).join(" ")}`);
  await new Promise(() => {});
}
const result = await ctx.rebuild();
await ctx.dispose();
const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`built ${path.relative(process.cwd(), dist)} (${(bytes / 1e6).toFixed(1)} MB with maps)`);
