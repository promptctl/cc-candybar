// The load gate: the built daemon serving 100 statusline sessions on a full
// config, each from its own checkout, the way their clients reach it. A build
// that cannot serve this cannot merge (.github/workflows/load-gate.yml).
//
// [LAW:one-source-of-truth] Nothing the gate judges by is a copy. Renders go
// through the client's own request (its budgets, its hints, its outcome
// classes); the daemon is spawned with the client's argv; memory is the charge
// the daemon's backstop judges, read through the backstop's own probe.
//
// [LAW:effects-at-boundaries] The world the daemon reads is built here and
// nowhere real: one temporary root holds its socket, XDG directories, Claude
// Code directory and the checkouts, and `git` and `gh` on its PATH are stubs.
// A stub asked anything it does not answer records it and the gate fails, so
// the stubs cannot quietly drift from what the daemon asks.
//
// Pass: every session answers before the warm deadline; every steady render
// answers ok within the client's budget; the daemon is the same process
// throughout with no post-mortem; its charge stays under the line the doctor
// calls near the limit and does not climb; the cache's held counts stay flat.
//
// Run: pnpm build && pnpm load-gate [--sessions N] [--seconds S]

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { nodeClientHint } from "../src/client-hint.js";
import { detectClientHints } from "../src/client-hints.js";
import { daemonArgs } from "../src/daemon/acquire.js";
import { tryRenderViaDaemon } from "../src/daemon/client.js";
import { fetchStats } from "../src/daemon/client-stats.js";
import { approachingLimit, mb, memoryLimitBytes } from "../src/daemon/limits.js";
import { chargeProbe } from "../src/daemon/memory-report.js";
import { PARENT_PID_ENV } from "../src/daemon/parent-watchdog.js";
import type { StatsSnapshot } from "../src/daemon/stats.js";
import { sourceDigest } from "../src/source-digest.js";
import type { ClaudeHookData } from "../src/utils/claude.js";

const REPO = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(REPO, "dist", "index.mjs");
const FIXTURES = path.join(import.meta.dirname, "load-gate");

const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "100" },
    seconds: { type: "string", default: "60" },
  },
});
const SESSIONS = Number(values.sessions);
const STEADY_MS = Number(values.seconds) * 1000;
if (!(Number.isInteger(SESSIONS) && SESSIONS > 0 && STEADY_MS > 0)) {
  throw new Error(`--sessions and --seconds must be positive: ${JSON.stringify(values)}`);
}

// Each session's statusline refreshes this often: 100 sessions ask ~60
// renders a second, five times what ~20 live sessions ask.
const SESSION_PERIOD_MS = 1600;
// An active session writes a turn to its transcript every few refreshes, and
// stages a file (its git index changes) less often.
const TURN_EVERY = 4;
const STAGE_EVERY = 8;
const TRANSCRIPT_TURNS = 60;
// A cold daemon builds every session's state at once; each session must have
// answered once by then.
const WARM_DEADLINE_MS = 30_000;
const SAMPLE_MS = 5000;
// What the charge may grow by across the steady phase, beyond a heap's
// sawtooth: the live daemon's climb is ~80 MB a minute.
const CLIMB_LIMIT_BYTES = 48 * 1024 * 1024;
const OID = "4f1c2a9e8b7d6c5a4f3e2d1c0b9a8f7e6d5c4b3a";

// ─── The world ──────────────────────────────────────────────────────────────

// Short, under /tmp: a unix socket path is capped at 104 bytes on macOS.
const root = fs.mkdtempSync("/tmp/cblg-");
const dirs = {
  state: path.join(root, "state"),
  cache: path.join(root, "cache"),
  config: path.join(root, "config"),
  data: path.join(root, "data"),
  claude: path.join(root, "claude"),
  bin: path.join(root, "bin"),
  checkouts: path.join(root, "w"),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const socket = path.join(dirs.state, "cc-candybar", "socket");
fs.mkdirSync(path.dirname(socket), { mode: 0o700 });
const unknownCalls = path.join(root, "unknown-calls");

fs.mkdirSync(path.join(dirs.config, "cc-candybar"));
fs.copyFileSync(
  path.join(FIXTURES, "config.json5"),
  path.join(dirs.config, "cc-candybar", "config.json5"),
);
fs.cpSync(path.join(FIXTURES, "plugins"), path.join(dirs.data, "cc-candybar", "plugins"), {
  recursive: true,
});

// The git lane's questions, answered as a checkout on its own branch with an
// upstream, one commit ahead, a modified file and an untracked one.
writeStub(
  "git",
  `case "$*" in
  "status --porcelain=v2 --branch")
    read -r ref < .git/HEAD; b=\${ref#ref: refs/heads/}
    printf '# branch.oid ${OID}\\n# branch.head %s\\n# branch.upstream origin/%s\\n# branch.ab +1 -0\\n1 .M N... 100644 100644 100644 ${OID} ${OID} src/index.ts\\n? notes.md\\n' "$b" "$b" ;;
  "log -1 --format=%ct ${OID} --") echo 1792970000 ;;
  "describe --tags --abbrev=0") echo v1.156.4 ;;
  "config --local --get-regexp ^remote\\..*\\.url$") echo "remote.origin.url git@github.com:promptctl/cc-candybar.git" ;;
  *) echo "git $*" >> "${unknownCalls}"; exit 1 ;;
esac`,
);
writeStub(
  "gh",
  `case "$*" in
  "pr view --json number,state,url,headRefOid")
    n=\${PWD##*/s}; printf '{"number":%d,"state":"OPEN","url":"https://github.com/promptctl/cc-candybar/pull/%d","headRefOid":"${OID}"}\\n' "$n" "$n" ;;
  *) echo "gh $*" >> "${unknownCalls}"; exit 1 ;;
esac`,
);

function writeStub(name: string, body: string): void {
  fs.writeFileSync(path.join(dirs.bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

interface Session {
  readonly index: number;
  readonly id: string;
  readonly checkout: string;
  readonly transcript: string;
  ticks: number;
  answered: boolean;
}

const sessions: Session[] = Array.from({ length: SESSIONS }, (_, index) => {
  const id = `5aec8cd7-7c8a-456f-84e0-${String(index).padStart(12, "0")}`;
  const checkout = path.join(dirs.checkouts, `s${index}`);
  fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
  fs.mkdirSync(path.join(checkout, ".lit"));
  fs.writeFileSync(path.join(checkout, ".git", "HEAD"), `ref: refs/heads/ticket-${index}\n`);
  fs.writeFileSync(path.join(checkout, ".git", "index"), "");
  fs.writeFileSync(path.join(checkout, ".lit", "statusline.json"), litStatusline(index));
  // Where Claude Code keeps a session's transcript: under its project's slug.
  const project = path.join(dirs.claude, "projects", checkout.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, `${id}.jsonl`);
  fs.writeFileSync(
    transcript,
    Array.from({ length: TRANSCRIPT_TURNS }, (_, t) => turn(id, checkout, t)).join(""),
  );
  return { index, id, checkout, transcript, ticks: 0, answered: false };
});

function litStatusline(index: number): string {
  const ticket = (n: number) => ({
    id: `brandon-unfiled-3248.t${n}`,
    title: `Ticket ${n}: a statusline segment that reads its checkout`,
    description: "What the ticket asks for, and why.",
  });
  return JSON.stringify({
    schema_version: 1,
    working_on: {
      ticket: ticket(index),
      rollup_progress: { rollup_completed_count: index % 9, rollup_total_count: 12 },
      phase: ["plan", "impl", "review", "merge"][index % 4],
      recorded_at: "2026-10-25T20:00:00Z",
    },
    next: { ticket: ticket(index + 1), recorded_at: "2026-10-25T20:00:00Z" },
  });
}

// One turn as Claude Code writes it: the prompt, the assistant's tool call
// with its usage, and the tool's result.
function turn(sessionId: string, cwd: string, t: number): string {
  const at = new Date(Date.now() - (TRANSCRIPT_TURNS - t) * 20_000).toISOString();
  const common = { sessionId, cwd, version: "2.1.299", gitBranch: "main", userType: "external" };
  const lines = [
    {
      ...common,
      type: "user",
      uuid: `u-${t}`,
      timestamp: at,
      message: { role: "user", content: `Step ${t}: run the tests and fix what fails. `.repeat(8) },
    },
    {
      ...common,
      type: "assistant",
      uuid: `a-${t}`,
      timestamp: at,
      requestId: `req_${t}`,
      message: {
        model: "claude-opus-5-5",
        id: `msg_${t}`,
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "C".repeat(900) },
          { type: "tool_use", id: `toolu_${t}`, name: "Bash", input: { command: "pnpm test" } },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 1200 + t,
          cache_read_input_tokens: 40_000 + 900 * t,
          output_tokens: 300 + t,
          service_tier: "standard",
          cache_creation: { ephemeral_1h_input_tokens: 1200 + t, ephemeral_5m_input_tokens: 0 },
        },
      },
    },
    {
      ...common,
      type: "user",
      uuid: `r-${t}`,
      timestamp: at,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `toolu_${t}`, content: "ok ".repeat(200) }],
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l) + "\n").join("");
}

// What Claude Code sends on a statusline refresh, as it moves through a session.
function hookData(s: Session): ClaudeHookData {
  const n = s.ticks;
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    hook_event_name: "Status",
    session_id: s.id,
    session_name: `ticket ${s.index}`,
    transcript_path: s.transcript,
    cwd: s.checkout,
    model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
    workspace: { current_dir: s.checkout, project_dir: s.checkout, added_dirs: [] },
    version: "2.1.299",
    output_style: { name: "default" },
    cost: {
      total_cost_usd: 1.5 + n * 0.02,
      total_duration_ms: 600_000 + n * SESSION_PERIOD_MS,
      total_api_duration_ms: 300_000 + n * 400,
      total_lines_added: 40 + n,
      total_lines_removed: 12 + (n >> 1),
    },
    context_window: {
      total_input_tokens: 60_000 + n * 900,
      total_output_tokens: 9000 + n * 40,
      context_window_size: 1_000_000,
      used_percentage: Math.min(95, 6 + n / 10),
      remaining_percentage: Math.max(5, 94 - n / 10),
      current_usage: {
        input_tokens: 2,
        output_tokens: 300,
        cache_creation_input_tokens: 1200,
        cache_read_input_tokens: 60_000 + n * 900,
      },
    },
    exceeds_200k_tokens: false,
    effort: { level: "high" },
    thinking: { enabled: true },
    rate_limits: {
      five_hour: { used_percentage: 41, resets_at: nowSec + 7200 },
      seven_day: { used_percentage: 23, resets_at: nowSec + 4 * 86_400 },
    },
  };
}

// ─── The daemon ─────────────────────────────────────────────────────────────

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${dirs.bin}${path.delimiter}${process.env.PATH ?? ""}`,
  CC_CANDYBAR_SOCKET: socket,
  XDG_STATE_HOME: dirs.state,
  XDG_CACHE_HOME: dirs.cache,
  XDG_CONFIG_HOME: dirs.config,
  XDG_DATA_HOME: dirs.data,
  // No package manager's plugin roots: only the fixtures' plugins load.
  XDG_DATA_DIRS: path.join(root, "none"),
  // A closed port: no release poll leaves the machine.
  CC_CANDYBAR_REGISTRY_URL: "http://127.0.0.1:1",
  // The daemon ends with the gate, however the gate ends.
  [PARENT_PID_ENV]: String(process.pid),
};
// The client half of the gate reaches the daemon through this process's env.
process.env.CC_CANDYBAR_SOCKET = socket;

const daemon = spawn(process.execPath, daemonArgs(BUNDLE, env), {
  env,
  stdio: ["ignore", "ignore", "inherit"],
});
let daemonExit: string | null = null;
daemon.on("exit", (code, signal) => {
  daemonExit = `exited code=${code} signal=${signal}`;
});

// The hints a client running in this session's terminal reports.
const sessionEnv = {
  CLAUDE_CONFIG_DIR: dirs.claude,
  TERM: "xterm-ghostty",
  TERM_PROGRAM: "ghostty",
  COLORTERM: "truecolor",
};
const client = nodeClientHint("node", BUNDLE);

interface Render {
  readonly phase: "warm" | "steady";
  readonly ms: number;
  // The client's own outcome: ok, or its failure class.
  readonly outcome: string;
}
const renders: Render[] = [];
let phase: Render["phase"] = "warm";
const inFlight = new Set<Promise<void>>();

function tick(s: Session): void {
  s.ticks++;
  if (s.ticks % TURN_EVERY === 0) {
    void fs.promises.appendFile(s.transcript, turn(s.id, s.checkout, TRANSCRIPT_TURNS + s.ticks));
  }
  if (s.ticks % STAGE_EVERY === 0) {
    const now = new Date();
    void fs.promises.utimes(path.join(s.checkout, ".git", "index"), now, now);
  }
  const rendering = phase;
  const t0 = performance.now();
  const done = tryRenderViaDaemon(hookData(s), [BUNDLE], s.checkout, {
    ...detectClientHints(sessionEnv, s.checkout, { columns: 160, rows: 48 }),
    client,
  }).then((outcome) => {
    renders.push({
      phase: rendering,
      ms: performance.now() - t0,
      outcome: outcome.kind === "ok" ? "ok" : `${outcome.kind}/${outcome.cause}`,
    });
    if (outcome.kind === "ok") s.answered = true;
    inFlight.delete(done);
  });
  inFlight.add(done);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Sample {
  readonly at: number;
  readonly stats: StatsSnapshot;
  readonly charge: number;
}
const samples: Sample[] = [];
// A daemon too busy to answer stats inside the stats client's budget.
const unanswered: string[] = [];
const charge = (pid: number) => chargeProbe(process.platform, pid);

async function sample(started: number): Promise<void> {
  const at = Date.now() - started;
  const outcome = await fetchStats();
  if (outcome.kind !== "ok") {
    unanswered.push(`${at} ms: ${outcome.kind}/${outcome.cause}`);
    return;
  }
  const reading = await charge(outcome.value.pid)(outcome.value.rssBytes);
  samples.push({ at, stats: outcome.value, charge: reading.bytes });
}

// ─── The run ────────────────────────────────────────────────────────────────

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

async function run(): Promise<{ checks: Check[]; facts: Record<string, unknown> }> {
  const bootDeadline = Date.now() + 15_000;
  let first: StatsSnapshot | null = null;
  while (first === null) {
    if (daemonExit !== null) throw new Error(`daemon ${daemonExit} before serving`);
    if (Date.now() > bootDeadline) throw new Error("daemon did not answer stats within 15 s");
    const outcome = await fetchStats();
    if (outcome.kind === "ok") first = outcome.value;
    else await sleep(50);
  }
  const digest = sourceDigest(path.join(REPO, "src"));
  if (first.sourceDigest !== digest) {
    throw new Error(
      `dist/ was built from other source (${first.sourceDigest} != ${digest}): run pnpm build`,
    );
  }

  const timers = sessions.map((s) =>
    setTimeout(() => {
      tick(s);
      timers[s.index] = setInterval(() => tick(s), SESSION_PERIOD_MS);
    }, (s.index * SESSION_PERIOD_MS) / SESSIONS),
  );
  const warmStarted = Date.now();
  while (!sessions.every((s) => s.answered) && Date.now() - warmStarted < WARM_DEADLINE_MS) {
    await sleep(50);
  }
  const warmMs = Date.now() - warmStarted;
  const silent = sessions.filter((s) => !s.answered).length;

  phase = "steady";
  const steadyStarted = Date.now();
  while (Date.now() - steadyStarted < STEADY_MS) {
    await sample(steadyStarted);
    await sleep(SAMPLE_MS);
  }
  for (const t of timers) clearInterval(t);
  await Promise.all(inFlight);
  await sample(steadyStarted);
  if (samples.length === 0) {
    throw new Error(`the daemon answered no stats sample: ${unanswered.join("; ")}`);
  }

  const limit = memoryLimitBytes(env);
  const steady = renders.filter((r) => r.phase === "steady");
  const failures = tally(steady.filter((r) => r.outcome !== "ok").map((r) => r.outcome));
  const expected = (SESSIONS * STEADY_MS) / SESSION_PERIOD_MS;
  const charges = samples.map((s) => s.charge);
  const third = Math.max(1, Math.floor(samples.length / 3));
  // What V8's heap does not hold: native allocations, code, mappings. The V8
  // heap itself sawtooths with collection, and its leaks are the held counts.
  const outside = samples.map((s) => s.charge - s.stats.heapTotalBytes);
  const climb = median(outside.slice(-third)) - median(outside.slice(0, third));
  const last = samples.at(-1)!.stats;
  const held = (pick: (s: StatsSnapshot) => number) => [...new Set(samples.map((s) => pick(s.stats)))];
  const counters = {
    entries: held((s) => s.renderCache.size),
    compiles: held((s) => s.renderCache.compiles),
    views: held((s) => s.renderCache.views),
    stateObservers: held((s) => s.sessionState.observers),
    watchers: held((s) => s.watchers.active),
  };
  const pids = [...new Set(samples.map((s) => s.stats.pid))];
  const postMortems = last.daemon.postMortems;
  const unknown = fs.existsSync(unknownCalls)
    ? [...new Set(fs.readFileSync(unknownCalls, "utf8").trim().split("\n"))]
    : [];
  const ms = steady.map((r) => r.ms).sort((a, b) => a - b);

  const checks: Check[] = [
    {
      name: "warm",
      pass: silent === 0,
      detail: `${SESSIONS - silent}/${SESSIONS} sessions answered in ${warmMs} ms`,
    },
    {
      name: "steady renders",
      pass: steady.length >= expected * 0.9 && Object.keys(failures).length === 0,
      detail: `${steady.length} renders (~${Math.round(expected)} asked), failures ${JSON.stringify(failures)}`,
    },
    {
      name: "stats answered",
      pass: unanswered.length === 0,
      detail: `${samples.length} samples answered, unanswered ${JSON.stringify(unanswered)}`,
    },
    {
      name: "one daemon",
      pass:
        daemonExit === null &&
        pids.length === 1 &&
        pids[0] === first.pid &&
        postMortems.kind === "ok" &&
        postMortems.value.length === 0,
      detail: `pids ${pids.join(",")} ${daemonExit ?? "running"}, post-mortems ${JSON.stringify(postMortems)}`,
    },
    {
      name: "charge under the limit",
      pass: charges.every((c) => !approachingLimit(c, limit)),
      detail: `max ${mb(Math.max(...charges))} MB of ${mb(limit)} MB`,
    },
    {
      name: "charge outside the heap not climbing",
      pass: climb <= CLIMB_LIMIT_BYTES,
      detail: `${mb(climb)} MB over the steady phase (limit ${mb(CLIMB_LIMIT_BYTES)} MB)`,
    },
    {
      name: "held counts flat",
      pass:
        Object.values(counters).every((v) => v.length === 1) &&
        last.renderCache.retired === 0 &&
        last.renderCache.retiredViews === 0,
      detail: `${JSON.stringify(counters)} retired ${last.renderCache.retired}/${last.renderCache.retiredViews}`,
    },
    {
      name: "stubs answered everything",
      pass: unknown.length === 0,
      detail: unknown.length === 0 ? "none unanswered" : unknown.join("; "),
    },
  ];
  const facts = {
    sessions: SESSIONS,
    steadySeconds: STEADY_MS / 1000,
    warmMs,
    warmRenders: tally(renders.filter((r) => r.phase === "warm").map((r) => r.outcome)),
    steadyRenders: steady.length,
    steadyMs: { p50: pct(ms, 0.5), p99: pct(ms, 0.99), max: ms.at(-1) ?? 0 },
    chargeMb: charges.map(mb),
    limitMb: mb(limit),
    rssMb: samples.map((s) => mb(s.stats.rssBytes)),
    heapUsedMb: samples.map((s) => mb(s.stats.heapUsedBytes)),
    heapTotalMb: samples.map((s) => mb(s.stats.heapTotalBytes)),
    outsideHeapMb: outside.map(mb),
    renderCache: last.renderCache,
    requests: last.requests,
  };
  return { checks, facts };
}

function tally(xs: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}
function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function pct(sorted: readonly number[], p: number): number {
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
}

// [LAW:no-silent-failure] Every way out is a verdict: a crash fails, and a
// failing run keeps its root (the daemon's log is in it) and says where.
let passed = false;
try {
  const { checks, facts } = await run();
  passed = checks.every((c) => c.pass);
  for (const c of checks) console.error(`${c.pass ? "pass" : "FAIL"}  ${c.name}: ${c.detail}`);
  console.log(JSON.stringify({ pass: passed, checks, facts }));
} catch (e) {
  console.error(`FAIL  ${e instanceof Error ? e.message : String(e)}`);
} finally {
  daemon.kill("SIGKILL");
  if (passed) fs.rmSync(root, { recursive: true, force: true });
  else console.error(`kept ${root} (daemon log: ${path.join(dirs.state, "cc-candybar", "daemon.log")})`);
}
process.exit(passed ? 0 : 1);
