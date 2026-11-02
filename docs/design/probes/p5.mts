import fs from "node:fs";
const R = "/tmp/ccb-probe/wt/src";
const imp = (p: string) => import(`${R}/${p}`);
const g = globalThis as any;
g.__wantAll = process.env.PROBE_ALL === "1";
const { Segment, Style, segmentsToString } = await import("/Users/bmf/code/cc-candybar/.claude/worktrees/synthetic-zooming-wind/node_modules/@promptctl/rich-js/dist/index.js");
const { linkSignerFromKeyFile } = await imp("daemon/link-key.ts");
const { repoGateAt } = await imp("daemon/repo-configs.ts");
const { repoGateLines } = await imp("config/loader/repo-gate.ts");
const { UNFOLLOWED_FEEDS } = await imp("config/lanes.ts");
const { homeLayer } = await imp("config/dsl-loader.ts");
const { loadChain, openView, UNOWNED_STORAGE } = await imp("daemon/cache/render.ts");
const { WatcherRegistry } = await imp("daemon/cache/watchers.ts");
const { FileEventDelivery } = await imp("daemon/cache/file-events.ts");
const { createPayloadProviders } = await imp("daemon/payload-providers.ts");
const { RefreshLedger } = await imp("utils/refresh-ledger.ts");
const { parseClientHints } = await imp("daemon/protocol.ts");
const { detectClientHints } = await imp("client-hints.ts");
const rp = await imp("daemon/render-payload.ts");
const { sessionIdOf } = await imp("daemon/session-id.ts");
const { sessionSource } = await imp("daemon/session-source.ts");
const { SessionState } = await imp("daemon/session-state.ts");
const { EMPTY_HISTORY_DEPTH } = await imp("daemon/settings-history.ts");
const { drawDsl, bindPayload, declareDslVariables, EVERY_SCOPE } = await imp("dsl/render.ts");
const { SessionEffects } = await imp("render/effect.ts");
const { instantOf } = await imp("utils/instant.ts");

const cwd = "/Users/bmf/code/cc-candybar/.claude/worktrees/synthetic-zooming-wind";
const configPath = process.env.PROBE_CONFIG!;
const sessionId = sessionIdOf("2a2e49fd-fc4c-49e5-977e-502da4cfa107");
const hookData: any = {
  hook_event_name: "Status",
  session_id: sessionId,
  transcript_path: "/tmp/ccb-probe/transcript.jsonl",
  cwd,
  model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
  cost: { total_cost_usd: 1.23, total_duration_ms: 1000 },
};
const hints = parseClientHints(detectClientHints(process.env, cwd, process.stdout));
const width = 140;
const logs: string[] = [];
const log = (l: string, m: string) => void (l !== "info" && logs.push(`${l}: ${m}`));
const watchers = new WatcherRegistry({ logger: log });
const providers = createPayloadProviders({
  watchers,
  fileEvents: new FileEventDelivery({ watchers, logger: log }),
  logger: log,
  ledger: new RefreshLedger(log),
});
const load = (sessionState: any) => {
  const repos = repoGateAt(cwd);
  const chain = { layers: [homeLayer(configPath)], home: configPath, repo: repos.plugins };
  const loaded = loadChain({ repos, advisories: repoGateLines(repos), started: performance.now() }, cwd, chain, {
    sessionState,
    storage: UNOWNED_STORAGE,
    signer: linkSignerFromKeyFile(),
  });
  if (loaded.state === null) throw loaded.cause;
  return loaded.state;
};

process.env.PROBE_ENV = "daemon-env";
fs.rmSync("/tmp/ccb-probe/shell-runs", { force: true });
fs.writeFileSync("/tmp/ccb-probe/value.txt", "file-value\n");
const ss = new SessionState();
const state = load(ss);
const view = openView(state, cwd, { sessionId, hookData, cwd, hints }, {
  sessionState: ss,
  declare: (h: any, f: any, c: any, s: any) => rp.declareLanes(providers, h, f, c, s),
  source: sessionSource({ providers, sessionState: ss, history: () => EMPTY_HISTORY_DEPTH, navigation: () => 0 }),
  changed: () => {},
  log,
});
const eff = view.source.effective();
const inputs = { hookData, deps: { ...providers, lanes: view.lanes }, cwd, neededInputPaths: state.neededInputPaths(eff.preset), hints };
const at0 = instantOf(new Date());
const refreshed = new Map();
const t0 = performance.now();
await rp.refreshPayload(inputs, at0, refreshed);
await rp.settlePayload(inputs, at0, refreshed);
const firstMs = Math.round(performance.now() - t0);
await new Promise((r) => setTimeout(r, 2500));
const t1 = performance.now();
const r2 = new Map();
await rp.refreshPayload(inputs, at0, r2);
await rp.settlePayload(inputs, at0, r2);
const againMs = Math.round(performance.now() - t1);
await new Promise((r) => setTimeout(r, 300));

const payload = view.source.payload();
const opts = rp.renderOptionsOf(eff, width);
const projections = (at: any) => ({
  drawing: { by: "request" },
  feeds: UNFOLLOWED_FEEDS,
  today: rp.todayOf(providers, view.lanes().today, hookData, at),
});
const drawA = (at: any) =>
  drawDsl(state.config, state.compiled, view.store, view.registry, projections(at), at, opts, undefined, {
    ...eff,
    effects: new SessionEffects(sessionId),
  });
const fresh = (s: any, scopes: any = new Set(["view"])) => {
  const st = load(s);
  const registry = st.registry.view();
  declareDslVariables(st.config, registry, cwd, scopes);
  return { state: st, registry };
};
const drawB = (r: any, wire: any, at: any) => {
  const drawn: any = bindPayload(r.state.compiled, r.registry.variableStore, r.registry, wire, opts, { ...eff });
  return drawDsl(r.state.config, r.state.compiled, r.registry.variableStore, r.registry, { ...drawn, ...projections(at) }, at, opts, undefined, {
    ...eff,
    effects: new SessionEffects(sessionId),
  });
};
const plain = (s: string) => s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;:]*m/g, "");
const out: any = { config: configPath, wantAll: g.__wantAll, logs };
const at = instantOf(new Date());

// 1. The frame wire: every row of every disclosure, as runs of plain JSON, back to ANSI.
const ATTRS = ["bold","dim","italic","underline","blink","blink2","reverse","conceal","strike","underline2","frame","encircle","overline"];
const toRun = (s: any) => {
  const st = s.style;
  return {
    t: s.text,
    ...(s.control && s.control.length ? { ctl: s.control } : {}),
    ...(st?.color ? { fg: st.color.name } : {}),
    ...(st?.bgcolor ? { bg: st.bgcolor.name } : {}),
    ...(st?.link ? { link: st.link } : {}),
    ...Object.fromEntries(ATTRS.filter((a) => st?.[a] !== undefined).map((a) => [a, st[a]])),
  };
};
const fromRun = (r: any) => {
  const { t, ctl, fg, bg, link, ...attrs } = r;
  const hasStyle = fg !== undefined || bg !== undefined || link !== undefined || Object.keys(attrs).length > 0;
  return new Segment(t, hasStyle ? new Style({ color: fg, bgcolor: bg, link, ...attrs }) : undefined, ctl);
};
const wire = { rows: 0, exact: 0, mismatch: 0, cases: 0, sample: null as any, runs: 0, jsonBytes: 0, ansiBytes: 0, control: 0, styleExtras: new Set<string>() };
const rowCheck = () => {
  for (const d of g.__drawn) {
    const runs = d.segments.map(toRun);
    const json = JSON.stringify(runs);
    const back = JSON.parse(json).map(fromRun);
    const text = segmentsToString(back, d.destination);
    wire.rows++;
    wire.runs += runs.length;
    wire.jsonBytes += json.length;
    wire.ansiBytes += d.text.length;
    wire.control += runs.filter((r: any) => r.ctl).length;
    for (const s of d.segments) {
      if (s.style?.meta) wire.styleExtras.add("meta");
    }
    if (text === d.text) wire.exact++;
    else {
      wire.mismatch++;
      if (!wire.sample) {
        let i = 0;
        while (i < text.length && text[i] === d.text[i]) i++;
        wire.sample = { i, want: JSON.stringify(d.text.slice(Math.max(0, i - 40), i + 50)), got: JSON.stringify(text.slice(Math.max(0, i - 40), i + 50)) };
      }
    }
  }
};
const coverage = { cells: 0, owned: 0, placements: new Set<string>() };
const attribute = () => {
  const owners = new Map(g.__items.map((it: any) => [it.owner, it.placement?.id]));
  for (const d of g.__drawn) {
    for (const s of d.segments) {
      const len = [...s.text].length;
      coverage.cells += len;
      let a = s.style?.anchor;
      let id: any;
      while (a !== undefined) {
        if (owners.has(a.owner)) id = owners.get(a.owner);
        a = a.inner;
      }
      if (id !== undefined) {
        coverage.owned += len;
        coverage.placements.add(id);
      }
    }
  }
};
g.__drawn = [];
g.__items = [];
const base = drawA(at);
rowCheck();
attribute();
wire.cases++;
const actions = Object.entries(state.config.actions ?? {}) as any[];
const opened: string[] = [];
for (const [name, a] of actions) {
  if (!Array.isArray(a?.cycle) || a.cycle.length !== 2 || typeof a.set !== "string") continue;
  ss.set(sessionId, a.set, a.cycle[1]);
  g.__drawn = [];
  g.__items = [];
  const f = drawA(at);
  if (f.text !== base.text) {
    opened.push(name);
    rowCheck();
    attribute();
    wire.cases++;
  }
  ss.clear(sessionId, a.set);
}
for (const [k, v] of [["candybar.menu", "open"]] as const) ss.set(sessionId, k, v);
g.__drawn = [];
g.__items = [];
const door = drawA(at);
out.door = { rows: door.text.split("\n").length, changed: door.text !== base.text, plain: plain(door.text).slice(0, 160) };
rowCheck();
attribute();
wire.cases++;
const pages = actions.filter(([, a]) => Array.isArray(a?.cycle) && a.cycle.length === 2 && typeof a.set === "string");
for (const [, a] of pages) {
  ss.set(sessionId, a.set, a.cycle[1]);
  g.__drawn = [];
  g.__items = [];
  const f = drawA(at);
  if (f.text !== door.text) {
    rowCheck();
    attribute();
    wire.cases++;
  }
  ss.clear(sessionId, a.set);
}
ss.clear(sessionId, "candybar.menu");
out.frameWire = { ...wire, styleExtras: [...wire.styleExtras], openedMenus: opened.length };
out.attribution = { pct: Math.round((1000 * coverage.owned) / coverage.cells) / 10, placements: coverage.placements.size };
g.__drawn = undefined;
g.__items = undefined;

// 2. The payload.
const json = JSON.stringify(payload);
out.payload = {
  bytes: json.length,
  keys: Object.keys(payload).length,
  has: Object.fromEntries(["session", "metrics", "activity", "context", "cache", "speed", "burn", "block", "weekly"].map((k) => [k, k in (payload as object)])),
  firstMs,
  againMs,
  refreshed: Object.fromEntries(refreshed),
  sampleMetrics: (payload as any).metrics,
};
if (process.env.PROBE_ALL === "1") {
  const narrow = JSON.parse(fs.readFileSync(`/tmp/ccb-probe/narrow-${process.env.PROBE_TAG}.json`, "utf8"));
  const r1 = fresh(ss);
  out.supersetBarIdentical = plainEq(drawB(r1, narrow, at).text, drawB(fresh(ss), JSON.parse(json), at).text);
} else fs.writeFileSync(`/tmp/ccb-probe/narrow-${process.env.PROBE_TAG}.json`, json);
function plainEq(a: string, b: string) {
  return { bytes: a === b, plain: plain(a) === plain(b), a: plain(a).slice(0, 220), b: plain(b).slice(0, 220) };
}

// 3. The supported sources: today, in a renderer, and carried by the payload.
if (process.env.PROBE_VARS === "1") {
  const names = ["probeShell", "probeJson", "probeKeyed", "probeFile", "probeEnv"];
  const a = drawA(at);
  const runsAfterDaemon = fs.readFileSync("/tmp/ccb-probe/shell-runs", "utf8").split("\n").length - 1;
  process.env.PROBE_ENV = "renderer-env";
  const r = fresh(new SessionState());
  const b = drawB(r, JSON.parse(json), at);
  await new Promise((res) => setTimeout(res, 1500));
  const b2 = drawB(r, JSON.parse(json), at);
  const runsAfterRenderer = fs.readFileSync("/tmp/ccb-probe/shell-runs", "utf8").split("\n").length - 1;
  const values: Record<string, unknown> = {};
  for (const n of names) {
    const kind = view.store.getKind(n);
    values[n] = /doc/i.test(String(kind)) ? (view.store.readDocument(n) as any) : view.store.read(n);
  }
  out.values = values;
  g.__wireVars = true;
  process.env.PROBE_ENV = "renderer-env";
  const r3 = fresh(new SessionState());
  const carried = drawB(r3, { ...JSON.parse(json), ...JSON.parse(JSON.stringify(values)) }, at);
  await new Promise((res) => setTimeout(res, 800));
  const carried2 = drawB(r3, { ...JSON.parse(json), ...JSON.parse(JSON.stringify(values)) }, at);
  g.__wireVars = false;
  const runsAfterCarried = fs.readFileSync("/tmp/ccb-probe/shell-runs", "utf8").split("\n").length - 1;
  out.sources = {
    daemon: plain(a.text),
    rendererToday: plain(b2.text),
    rendererImmediately: plain(b.text),
    rendererEqualsDaemon: a.text === b2.text,
    shellRuns: { afterDaemon: runsAfterDaemon, afterRenderer: runsAfterRenderer, afterCarried: runsAfterCarried },
    carried: plain(carried2.text),
    carriedEqualsDaemon: carried2.text === a.text,
    carriedPending: carried2.pending,
  };
}
console.log(JSON.stringify(out, null, 1));
process.exit(0);
