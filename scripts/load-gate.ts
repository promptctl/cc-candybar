// The load gate: the built daemon serving 100 statusline sessions on a full
// config, each from its own checkout, the way their clients reach it. A build
// that cannot serve this cannot merge (.github/workflows/load-gate.yml).
//
// [LAW:one-source-of-truth] Nothing the gate judges by is a copy. Renders go
// through the client's own request (its budgets, its hints, its outcome
// classes); the daemon is spawned with the client's argv, plus an inspector,
// the one way to collect its heap before reading it (twice, outside the scored
// renders); memory is the charge the daemon's backstop judges, read through the
// backstop's own probe.
//
// [LAW:effects-at-boundaries] The world the daemon reads is built here and
// nowhere real: one temporary root holds its socket, XDG directories, Claude
// Code directory and the checkouts, and `git` and `gh` on its PATH are stubs.
// A stub asked anything it does not answer records it and the gate fails, so
// the stubs cannot quietly drift from what the daemon asks.
//
// Pass: every session answers before the warm deadline; every steady render
// answers ok within the client's budget; the daemon is the same process
// throughout with no post-mortem; its charge stays within a budget for these
// sessions and does not climb; the cache's held counts stay flat.
//
// Run: pnpm build && pnpm load-gate [--sessions N] [--seconds S]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { nodeClientHint } from "../src/client-hint.js";
import { detectClientHints } from "../src/client-hints.js";
import { daemonArgs } from "../src/daemon/acquire.js";
import { tryRenderViaDaemon } from "../src/daemon/client.js";
import { fetchStats } from "../src/daemon/client-stats.js";
import { mb, memoryLimitBytes } from "../src/daemon/limits.js";
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
  throw new Error(
    `--sessions and --seconds must be positive: ${JSON.stringify(values)}`,
  );
}

// Each session's statusline refreshes this often: 100 sessions ask ~60
// renders a second, five times what ~20 live sessions ask.
const SESSION_PERIOD_MS = 1600;
// An active session writes a turn to its transcript every few refreshes, and
// stages a file (its git index changes) less often.
const TURN_EVERY = 4;
const STAGE_EVERY = 8;
// And now and then switches branch.
const BRANCH_EVERY = 64;
// A long session's transcript: ~5000 lines.
const TRANSCRIPT_TURNS = 1700;
// A cold daemon builds every session's state at once; each session must have
// answered once by then.
const WARM_DEADLINE_MS = 30_000;
const SAMPLE_MS = 5000;
const INSPECTOR_CALL_MS = 30_000;
// What the charge may grow by across the steady phase, beyond a heap's
// sawtooth: the live daemon's climb is ~80 MB a minute.
const CLIMB_LIMIT_BYTES = 32 * 1024 * 1024;
// What these sessions may be charged: ~430 MB measured on macOS and Linux, and
// a fifth more. The shipped limit is sized for the backstop, and judging by it
// would pass a daemon nearly twice as heavy.
const BUDGET_BYTES = 512 * 1024 * 1024;
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
  home: path.join(root, "home"),
};
for (const d of Object.values(dirs))
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const socket = path.join(dirs.state, "cc-candybar", "socket");
fs.mkdirSync(path.dirname(socket), { mode: 0o700 });
const unknownCalls = path.join(root, "unknown-calls");

fs.mkdirSync(path.join(dirs.config, "cc-candybar"));
fs.copyFileSync(
  path.join(FIXTURES, "config.json5"),
  path.join(dirs.config, "cc-candybar", "config.json5"),
);
fs.cpSync(
  path.join(FIXTURES, "plugins"),
  path.join(dirs.data, "cc-candybar", "plugins"),
  {
    recursive: true,
  },
);

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
    n=\$(( \${PWD##*/s} + 1 )); printf '{"number":%d,"state":"OPEN","url":"https://github.com/promptctl/cc-candybar/pull/%d","headRefOid":"${OID}"}\\n' "$n" "$n" ;;
  *) echo "gh $*" >> "${unknownCalls}"; exit 1 ;;
esac`,
);

function writeStub(name: string, body: string): void {
  fs.writeFileSync(path.join(dirs.bin, name), `#!/bin/sh\n${body}\n`, {
    mode: 0o755,
  });
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
  // A checkout's .git as git leaves it: the daemon dates what it holds by these
  // files (the remotes by the config, the watch on refs/heads), so one missing
  // makes it ask git again on every refresh, which a real checkout never does.
  fs.mkdirSync(path.join(checkout, ".git", "refs", "heads"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(checkout, ".lit"));
  fs.writeFileSync(
    path.join(checkout, ".git", "HEAD"),
    `ref: refs/heads/ticket-${index}\n`,
  );
  fs.writeFileSync(
    path.join(checkout, ".git", "refs", "heads", `ticket-${index}`),
    `${OID}\n`,
  );
  fs.writeFileSync(
    path.join(checkout, ".git", "config"),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:promptctl/cc-candybar.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  fs.writeFileSync(path.join(checkout, ".git", "index"), "");
  fs.writeFileSync(
    path.join(checkout, ".lit", "statusline.json"),
    litStatusline(index),
  );
  // Where Claude Code keeps a session's transcript: under its project's slug.
  const project = path.join(
    dirs.claude,
    "projects",
    checkout.replace(/[^A-Za-z0-9]/g, "-"),
  );
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, `${id}.jsonl`);
  fs.writeFileSync(
    transcript,
    Array.from({ length: TRANSCRIPT_TURNS }, (_, t) =>
      turn(id, checkout, t),
    ).join(""),
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
      rollup_progress: {
        rollup_completed_count: index % 9,
        rollup_total_count: 12,
      },
      phase: ["plan", "impl", "review", "merge"][index % 4],
      recorded_at: "2026-10-25T20:00:00Z",
    },
    next: { ticket: ticket(index + 1), recorded_at: "2026-10-25T20:00:00Z" },
  });
}

// One turn as Claude Code writes it: the prompt, the assistant's tool call
// with its usage, and the tool's result.
function turn(sessionId: string, cwd: string, t: number): string {
  const at = new Date(
    Date.now() - Math.max(0, TRANSCRIPT_TURNS - t) * 20_000,
  ).toISOString();
  const common = {
    sessionId,
    cwd,
    version: "2.1.299",
    gitBranch: "main",
    userType: "external",
  };
  const lines = [
    {
      ...common,
      type: "user",
      uuid: `u-${t}`,
      timestamp: at,
      message: {
        role: "user",
        content: `Step ${t}: run the tests and fix what fails. `.repeat(8),
      },
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
          {
            type: "tool_use",
            id: `toolu_${t}`,
            name: "Bash",
            input: { command: "pnpm test" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 1200 + t,
          cache_read_input_tokens: 40_000 + 900 * t,
          output_tokens: 300 + t,
          service_tier: "standard",
          cache_creation: {
            ephemeral_1h_input_tokens: 1200 + t,
            ephemeral_5m_input_tokens: 0,
          },
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
        content: [
          {
            type: "tool_result",
            tool_use_id: `toolu_${t}`,
            content: "ok ".repeat(200),
          },
        ],
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
    workspace: {
      current_dir: s.checkout,
      project_dir: s.checkout,
      added_dirs: [],
    },
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

// [LAW:effects-at-boundaries] The daemon's whole environment, named here: the
// shell that runs the gate reaches it only through PATH (for node and sh) and
// the temp dir, so a limit, NODE_OPTIONS or tmux session exported there
// cannot change the verdict.
const env: NodeJS.ProcessEnv = {
  PATH: `${dirs.bin}${path.delimiter}${process.env.PATH ?? ""}`,
  HOME: dirs.home,
  TMPDIR: os.tmpdir(),
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

// The daemon as the client spawns it, plus an inspector on a loopback port:
// the one way to read its live heap is to collect it first.
const daemon = spawn(
  process.execPath,
  ["--inspect=127.0.0.1:0", ...daemonArgs(BUNDLE, env)],
  { env, stdio: ["ignore", "ignore", "pipe"] },
);
const inspectorUrl = new Promise<string>((resolve) => {
  let text = "";
  daemon.stderr.on("data", (chunk: Buffer) => {
    text += chunk.toString();
    const url = /Debugger listening on (ws:\S+)/.exec(text)?.[1];
    if (url !== undefined) resolve(url);
    // Everything but the inspector's own banner is the daemon's to say.
    for (const line of chunk.toString().split("\n")) {
      if (line !== "" && !/Debugger listening|For help, see/.test(line))
        console.error(line);
    }
  });
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
  readonly phase: "warm" | "steady" | "after";
  readonly ms: number;
  // The client's own outcome: ok, or its failure class.
  readonly outcome: string;
}
const renders: Render[] = [];
let phase: Render["phase"] = "warm";
const inFlight = new Set<Promise<void>>();

// [LAW:no-silent-failure] A session's own write that fails is a verdict too:
// the load it stood for never happened.
const sessionWriteFailures: string[] = [];
function sessionWrite(what: string, write: Promise<void>): void {
  write.catch((e: unknown) =>
    sessionWriteFailures.push(
      `${what}: ${e instanceof Error ? e.message : String(e)}`,
    ),
  );
}

function tick(s: Session): void {
  s.ticks++;
  // Offset by session, so sessions write, stage and switch at their own moments.
  const at = s.ticks + s.index;
  if (at % TURN_EVERY === 0) {
    sessionWrite(
      "transcript turn",
      fs.promises.appendFile(
        s.transcript,
        turn(s.id, s.checkout, TRANSCRIPT_TURNS + s.ticks),
      ),
    );
  }
  if (at % STAGE_EVERY === 0) {
    const now = new Date();
    sessionWrite(
      "stage",
      fs.promises.utimes(path.join(s.checkout, ".git", "index"), now, now),
    );
  }
  if (at % BRANCH_EVERY === 0) {
    // As git checks out a branch: its ref first, then HEAD names it.
    const branch = `ticket-${s.index}-${s.ticks}`;
    const gitDir = path.join(s.checkout, ".git");
    sessionWrite(
      "branch switch",
      fs.promises
        .writeFile(path.join(gitDir, "refs", "heads", branch), `${OID}\n`)
        .then(() =>
          fs.promises.writeFile(
            path.join(gitDir, "HEAD"),
            `ref: refs/heads/${branch}\n`,
          ),
        ),
    );
  }
  const rendering = phase;
  const t0 = performance.now();
  const done = (async () => {
    let outcome: string;
    try {
      const rendered = await tryRenderViaDaemon(
        hookData(s),
        [BUNDLE],
        s.checkout,
        {
          ...detectClientHints(sessionEnv, s.checkout, {
            columns: 160,
            rows: 48,
          }),
          client,
        },
      );
      outcome =
        rendered.kind === "ok" ? "ok" : `${rendered.kind}/${rendered.cause}`;
      if (rendered.kind === "ok") s.answered = true;
    } catch (e) {
      // [LAW:no-silent-failure] A client path that throws is a failed render,
      // scored like any other, never a gate that ends without a verdict.
      outcome = `threw/${e instanceof Error ? e.message : String(e)}`;
    }
    renders.push({ phase: rendering, ms: performance.now() - t0, outcome });
  })();
  inFlight.add(done);
  void done.finally(() => inFlight.delete(done));
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

// The daemon's heap once everything unreachable is collected, through its
// inspector. A heap read between collections is mostly garbage V8 has not
// yet had reason to collect.
async function liveHeap(): Promise<number> {
  const ws = new WebSocket(await inspectorUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("daemon inspector refused the gate"));
  });
  // An answer, or a failure: the daemon dying under the call closes the socket,
  // and one that never answers runs out the call's time.
  const call = (id: number, method: string) =>
    new Promise<{ usedSize?: number }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`daemon inspector: no answer to ${method}`)),
        INSPECTOR_CALL_MS,
      );
      ws.onclose = () => {
        clearTimeout(timer);
        reject(new Error(`daemon inspector closed during ${method}`));
      };
      ws.addEventListener("message", function answer(e: MessageEvent) {
        const reply = JSON.parse(String(e.data)) as {
          id?: number;
          result: { usedSize?: number };
        };
        if (reply.id !== id) return;
        ws.removeEventListener("message", answer);
        clearTimeout(timer);
        resolve(reply.result);
      });
      ws.send(JSON.stringify({ id, method }));
    });
  await call(1, "HeapProfiler.collectGarbage");
  const { usedSize } = await call(2, "Runtime.getHeapUsage");
  ws.onclose = null;
  ws.close();
  if (usedSize === undefined)
    throw new Error("daemon inspector reported no heap usage");
  return usedSize;
}

// ─── The run ────────────────────────────────────────────────────────────────

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

async function run(): Promise<{
  checks: Check[];
  facts: Record<string, unknown>;
}> {
  const bootDeadline = Date.now() + 15_000;
  let first: StatsSnapshot | null = null;
  while (first === null) {
    if (daemonExit !== null)
      throw new Error(`daemon ${daemonExit} before serving`);
    if (Date.now() > bootDeadline)
      throw new Error("daemon did not answer stats within 15 s");
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
    setTimeout(
      () => {
        tick(s);
        timers[s.index] = setInterval(() => tick(s), SESSION_PERIOD_MS);
      },
      (s.index * SESSION_PERIOD_MS) / SESSIONS,
    ),
  );
  const warmStarted = Date.now();
  while (
    !sessions.every((s) => s.answered) &&
    Date.now() - warmStarted < WARM_DEADLINE_MS
  ) {
    await sleep(50);
  }
  const warmMs = Date.now() - warmStarted;
  // Before the steady phase, so no scored render waits on the collection.
  const heapBefore = await liveHeap();
  const silent = sessions.filter((s) => !s.answered).length;

  phase = "steady";
  const steadyStarted = Date.now();
  // The gate's own event loop: a render it measured late may be its own lag.
  const gateLoop = monitorEventLoopDelay({ resolution: 5 });
  gateLoop.enable();
  while (Date.now() - steadyStarted < STEADY_MS) {
    await sample(steadyStarted);
    await sleep(SAMPLE_MS);
  }
  gateLoop.disable();
  // The second reading under the load the first was taken under: the steady
  // renders settle, and those the collection delays are not scored.
  phase = "after";
  await Promise.all(inFlight);
  const steadyEnded = Date.now();
  const heapAfter = await liveHeap();
  for (const t of timers) clearInterval(t);
  await Promise.all(inFlight);
  // The first and last samples each follow a collection.
  await sample(steadyStarted);
  if (samples.length === 0) {
    throw new Error(
      `the daemon answered no stats sample: ${unanswered.join("; ")}`,
    );
  }

  const limit = memoryLimitBytes(env);
  const steady = renders.filter((r) => r.phase === "steady");
  const failures = tally(
    steady.filter((r) => r.outcome !== "ok").map((r) => r.outcome),
  );
  const expected = (SESSIONS * STEADY_MS) / SESSION_PERIOD_MS;
  const charges = samples.map((s) => s.charge);
  const climb = heapAfter - heapBefore;
  const first0 = samples[0]!.stats;
  // The charge under load, over the steady phase's second half: in the first
  // the allocator is still filling to the load's working set, and a leak keeps
  // climbing after it is full. Charge less V8's heap is no measure of native
  // memory: the heap gives back pages it never touched, which the charge never
  // counted, so the difference grows as the heap shrinks.
  const underLoad = charges.slice(0, -1);
  const secondHalf = underLoad.slice(Math.floor(underLoad.length / 2));
  // Two samples at least, or there is no climb to judge: a run whose samples
  // went unanswered fails here as well as on its own check.
  const chargeClimb =
    secondHalf.length < 2 ? null : secondHalf.at(-1)! - secondHalf[0]!;
  const last = samples.at(-1)!.stats;
  const held = (pick: (s: StatsSnapshot) => number) => [
    ...new Set(samples.map((s) => pick(s.stats))),
  ];
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
      pass:
        steady.length >= expected * 0.9 && Object.keys(failures).length === 0,
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
      name: "charge within the budget",
      pass: charges.every((c) => c <= BUDGET_BYTES),
      detail: `max ${mb(Math.max(...charges))} MB of ${mb(BUDGET_BYTES)} MB (limit ${mb(limit)} MB)`,
    },
    {
      name: "live heap not climbing",
      pass: climb <= CLIMB_LIMIT_BYTES,
      detail: `${mb(heapBefore)} MB to ${mb(heapAfter)} MB over the steady phase (limit +${mb(CLIMB_LIMIT_BYTES)} MB)`,
    },
    {
      name: "charge not climbing under load",
      pass: chargeClimb !== null && chargeClimb <= CLIMB_LIMIT_BYTES,
      detail:
        chargeClimb === null
          ? `${secondHalf.length} sample(s) in the steady phase's second half, too few to judge`
          : `${mb(secondHalf[0]!)} MB to ${mb(secondHalf.at(-1)!)} MB over the steady phase's second half (limit +${mb(CLIMB_LIMIT_BYTES)} MB)`,
    },
    {
      // Watchers opened and closed while the watched set holds still: the
      // churn behind native growth the heap never shows.
      name: "no watcher churn",
      pass:
        last.watchers.opened === first0.watchers.opened &&
        last.watchers.closed === first0.watchers.closed,
      detail: `${last.watchers.opened - first0.watchers.opened} opened, ${last.watchers.closed - first0.watchers.closed} closed over the steady phase`,
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
    {
      name: "session writes landed",
      pass: sessionWriteFailures.length === 0,
      detail:
        sessionWriteFailures.length === 0
          ? "every turn, stage and branch switch"
          : sessionWriteFailures.slice(0, 5).join("; "),
    },
  ];
  const facts = {
    sessions: SESSIONS,
    steadySeconds: STEADY_MS / 1000,
    warmMs,
    warmRenders: tally(
      renders.filter((r) => r.phase === "warm").map((r) => r.outcome),
    ),
    steadyRenders: steady.length,
    steadyMs: { p50: pct(ms, 0.5), p99: pct(ms, 0.99), max: ms.at(-1) ?? 0 },
    chargeMb: charges.map(mb),
    limitMb: mb(limit),
    rssMb: samples.map((s) => mb(s.stats.rssBytes)),
    heapUsedMb: samples.map((s) => mb(s.stats.heapUsedBytes)),
    heapTotalMb: samples.map((s) => mb(s.stats.heapTotalBytes)),
    // How long each steady render waited in the daemon before it began and how
    // long it then took, from its own render events, beside the gate's lag: a
    // slow round trip is one of the three.
    daemonRenderMs: await daemonRenders(steadyStarted, steadyEnded),
    gateLoopDelayMs: {
      p99: Math.round(gateLoop.percentile(99) / 1e6),
      max: Math.round(gateLoop.max / 1e6),
    },
    renderCache: last.renderCache,
    requests: last.requests,
  };
  return { checks, facts };
}

// What the daemon itself took over every render it finished in the window.
// It writes its log off its event loop, in order, through one writer, so the
// window's last events have landed once any line after the window has.
async function daemonRenders(
  since: number,
  until: number,
): Promise<Record<"took" | "waited", Record<string, number>>> {
  const log = path.join(dirs.state, "cc-candybar", "daemon.log");
  const stamped = (): Array<{ at: number; line: string }> =>
    [`${log}.3`, `${log}.2`, `${log}.1`, log]
      .filter((f) => fs.existsSync(f))
      .flatMap((f) => fs.readFileSync(f, "utf8").split("\n"))
      .map((line) => ({ at: Date.parse(line.slice(0, 24)), line }));
  let all = stamped();
  for (
    const giveUp = Date.now() + 10_000;
    !all.some(({ at }) => at > until) && Date.now() < giveUp;
  ) {
    await sleep(200);
    all = stamped();
  }
  const lines = all
    .filter(
      ({ at, line }) =>
        at >= since &&
        at <= until &&
        line.includes("] render ") &&
        line.includes(" took="),
    )
    .map(({ line }) => line);
  const spread = (field: string): Record<string, number> => {
    const ms = lines
      .map((l) => Number(new RegExp(` ${field}=(\\d+)ms`).exec(l)?.[1]))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    return { n: ms.length, p99: pct(ms, 0.99), max: ms.at(-1) ?? 0 };
  };
  return { took: spread("took"), waited: spread("waited") };
}

function tally(xs: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}
function pct(sorted: readonly number[], p: number): number {
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0,
  );
}

// [LAW:no-silent-failure] Every way out is a verdict: a crash fails, and a
// failing run keeps its root (the daemon's log is in it) and says where.
// A gate that hangs (a daemon that stopped answering its inspector, a render
// that never settles) ends here, with its root kept, before CI cancels it.
// Counted from the process's start, the fixture's building included.
const GATE_DEADLINE_MS = 3 * 60_000;
let passed = false;
try {
  const { checks, facts } = await Promise.race([
    run(),
    sleep(GATE_DEADLINE_MS - performance.now()).then(() => {
      throw new Error(
        `the gate ran past its ${GATE_DEADLINE_MS / 60_000} minutes`,
      );
    }),
  ]);
  passed = checks.every((c) => c.pass);
  for (const c of checks)
    console.error(`${c.pass ? "pass" : "FAIL"}  ${c.name}: ${c.detail}`);
  console.log(JSON.stringify({ pass: passed, checks, facts }));
} catch (e) {
  console.error(`FAIL  ${e instanceof Error ? e.message : String(e)}`);
} finally {
  // The root goes once nothing writes into it: the daemon and its stubs gone.
  const gone = new Promise((resolve) => daemon.once("exit", resolve));
  daemon.kill("SIGKILL");
  if (daemonExit === null) await Promise.race([gone, sleep(5000)]);
  if (passed) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  else
    console.error(
      `kept ${root} (daemon log: ${path.join(dirs.state, "cc-candybar", "daemon.log")})`,
    );
}
process.exit(passed ? 0 : 1);
