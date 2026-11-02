// A Draw alone: load, compile, bind a recorded payload, draw. No providers.
// Measures memory, and counts every filesystem and process call a draw makes.
import fs from "node:fs";
import fsp from "node:fs/promises";
import cp from "node:child_process";
const R = "/tmp/ccb-probe/wt/src";
const imp = (p: string) => import(`${R}/${p}`);
const rss = () => Math.round(process.memoryUsage().rss / 1e6);
const heap = () => Math.round(process.memoryUsage().heapUsed / 1e6);
const out: any = { baselineRssMb: rss(), baselineHeapMb: heap() };
const { linkSignerFromKeyFile } = await imp("daemon/link-key.ts");
const { repoGateAt } = await imp("daemon/repo-configs.ts");
const { repoGateLines } = await imp("config/loader/repo-gate.ts");
const { UNFOLLOWED_FEEDS } = await imp("config/lanes.ts");
const { homeLayer } = await imp("config/dsl-loader.ts");
const { loadChain, UNOWNED_STORAGE } = await imp("daemon/cache/render.ts");
const rp = await imp("daemon/render-payload.ts");
const { SessionState } = await imp("daemon/session-state.ts");
const { sessionIdOf } = await imp("daemon/session-id.ts");
const { drawDsl, bindPayload, declareDslVariables } = await imp("dsl/render.ts");
const { resolveEffectiveGlobals } = await imp("config/effective-globals.ts");
const { SessionEffects } = await imp("render/effect.ts");
const { instantOf } = await imp("utils/instant.ts");
out.afterImportsRssMb = rss();

const cwd = "/Users/bmf/code/cc-candybar/.claude/worktrees/synthetic-zooming-wind";
const configPath = process.env.PROBE_CONFIG!;
const payload = JSON.parse(fs.readFileSync(process.env.PROBE_PAYLOAD!, "utf8"));
const sessionId = sessionIdOf("2a2e49fd-fc4c-49e5-977e-502da4cfa107");
const ss = new SessionState();
const repos = repoGateAt(cwd);
const t0 = performance.now();
const loaded = loadChain(
  { repos, advisories: repoGateLines(repos), started: performance.now() },
  cwd,
  { layers: [homeLayer(configPath)], home: configPath, repo: repos.plugins },
  { sessionState: ss, storage: UNOWNED_STORAGE, signer: linkSignerFromKeyFile() },
);
if (loaded.state === null) throw loaded.cause;
const state = loaded.state;
out.loadMs = Math.round(performance.now() - t0);
out.afterLoadRssMb = rss();
const registry = state.registry.view();
declareDslVariables(state.config, registry, cwd, new Set(["view"]));
const eff = resolveEffectiveGlobals(state.config, () => null, () => false);
const opts = rp.renderOptionsOf(eff, 140);
const effects = new SessionEffects(sessionId);
const draw = (at: any) => {
  const drawn: any = bindPayload(state.compiled, registry.variableStore, registry, payload, opts, eff);
  return drawDsl(state.config, state.compiled, registry.variableStore, registry,
    { ...drawn, drawing: { by: "feed" }, feeds: UNFOLLOWED_FEEDS, today: undefined }, at, opts, undefined, { ...eff, effects });
};
const t1 = performance.now();
const first = draw(instantOf(new Date()));
out.firstDrawMs = Math.round(performance.now() - t1);
out.firstDrawPending = first.pending;

// Count every effect during draws.
const calls: Record<string, number> = {};
const wrap = (obj: any, tag: string) => {
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] !== "function") continue;
    const orig = obj[k];
    try {
      obj[k] = function (...a: unknown[]) {
        calls[`${tag}.${k}`] = (calls[`${tag}.${k}`] ?? 0) + 1;
        return orig.apply(this, a);
      };
    } catch {}
  }
};
wrap(fs, "fs");
wrap(fsp, "fsp");
wrap(cp, "cp");
const nodeModule = await import("node:module");
nodeModule.syncBuiltinESMExports();
const named = await import("node:fs");
named.existsSync("/");
const namedP = await import("node:fs/promises");
await namedP.stat("/");
cp.execFileSync("/usr/bin/true");
out.controlFired = { ...calls };
for (const k of Object.keys(calls)) delete calls[k];
const t2 = performance.now();
const N = 300;
for (let i = 0; i < N; i++) draw(instantOf(new Date(Date.now() + i * 33)));
out.drawMsMean = Math.round(((performance.now() - t2) / N) * 100) / 100;
out.effectCallsIn300Draws = calls;
const { AnsiDecoder } = await import("/Users/bmf/code/cc-candybar/.claude/worktrees/synthetic-zooming-wind/node_modules/@promptctl/rich-js/dist/index.js");
void AnsiDecoder;
(globalThis as any).__drawn = [];
const frames: any[] = [];
const ATTRS = ["bold", "dim", "italic", "underline", "reverse", "strike"];
for (let i = 0; i < 120; i++) {
  (globalThis as any).__drawn = [];
  draw(instantOf(new Date(Date.now() + i * 33)));
  frames.push(
    (globalThis as any).__drawn.map((d: any) =>
      d.segments.filter((s: any) => !s.text.includes("\n") || s.text.length > 1).map((s: any) => ({
        t: s.text.replace(/\n/g, ""),
        ...(s.style?.color?.name ? { fg: s.style.color.name } : {}),
        ...(s.style?.bgcolor?.name ? { bg: s.style.bgcolor.name } : {}),
        ...(s.style?.link ? { link: s.style.link } : {}),
        ...Object.fromEntries(ATTRS.filter((a) => s.style?.[a]).map((a) => [a, true])),
      })),
    ),
  );
}
(globalThis as any).__drawn = undefined;
fs.writeFileSync("/tmp/ccb-probe/frames.json", JSON.stringify(frames));
out.frameJsonBytes = Math.round(JSON.stringify(frames).length / frames.length);
out.finalRssMb = rss();
out.finalHeapMb = heap();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
