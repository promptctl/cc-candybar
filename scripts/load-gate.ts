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
// throughout with no post-mortem; its charge once V8 has collected stays
// within a budget for these sessions, and under load does not climb; the
// cache's held counts stay flat; every click on one session's settings menu,
// once a second, answers ok within the click's budget.
//
// Run: pnpm build && pnpm load-gate [--sessions N] [--seconds S]
//
// The feed measurement (the frame-feed epic's criterion): the same world with
// a moving bar and its statusline lane on, measured without a feed (`off`,
// the baseline) and with one session's feed open (`on`), both at 1 Hz:
//   pnpm load-gate --sessions 20 --period-ms 1000 --feed off > off.json
//   pnpm load-gate --sessions 20 --period-ms 1000 --feed on --baseline off.json
// The `on` run adds two checks: the moving feed draws at its ceiling on its
// summary line, and the statusline's `took=` p90 is within 2x of the
// baseline's.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { nodeClientHint } from "../src/client-hint.js";
import { detectClientHints } from "../src/client-hints.js";
import { daemonArgs } from "../src/daemon/acquire.js";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire.js";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure.js";
import { tryClickViaDaemon, tryRenderViaDaemon } from "../src/daemon/client.js";
import { fetchStats } from "../src/daemon/client-stats.js";
import { mb, memoryLimitBytes } from "../src/daemon/limits.js";
import { logLines } from "../src/daemon/log.js";
import { logPath } from "../src/daemon/paths.js";
import { chargeProbe } from "../src/daemon/memory-report.js";
import { processLauncher } from "../src/proc/launch.js";
import {
  openFrameStream,
  type StreamEnd,
} from "../src/daemon/client-frames.js";
import { PARENT_PID_ENV } from "../src/daemon/parent-watchdog.js";
import type { StatsSnapshot } from "../src/daemon/stats.js";
import { parseHandlerUrl } from "../src/install/index.js";
import { sourceDigest } from "../src/source-digest.js";
import type { ClaudeHookData } from "../src/utils/claude.js";
import { percentile } from "./lib/percentile.js";
import { sessionEnv } from "./lib/session-env.js";
import { transcriptPath, transcriptTurn } from "./lib/transcript.js";

const REPO = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(REPO, "dist", "index.mjs");
const FIXTURES = path.join(import.meta.dirname, "load-gate");

const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "100" },
    seconds: { type: "string", default: "60" },
    // Each session's statusline refreshes this often: 100 sessions ask ~60
    // renders a second, five times what ~20 live sessions ask.
    "period-ms": { type: "string", default: "1600" },
    feed: { type: "string" },
    baseline: { type: "string" },
  },
});
const SESSIONS = Number(values.sessions);
const STEADY_MS = Number(values.seconds) * 1000;
const SESSION_PERIOD_MS = Number(values["period-ms"]);
if (
  !(
    Number.isInteger(SESSIONS) &&
    SESSIONS > 0 &&
    STEADY_MS > 0 &&
    SESSION_PERIOD_MS > 0
  )
) {
  throw new Error(
    `--sessions, --seconds and --period-ms must be positive: ${JSON.stringify(values)}`,
  );
}
// [LAW:parse-dont-validate] The feed's world, or none: the gate as CI runs it.
type FeedWorld = "off" | "on" | null;
const FEED: FeedWorld =
  values.feed === undefined
    ? null
    : values.feed === "off" || values.feed === "on"
      ? values.feed
      : (() => {
          throw new Error(`--feed is off or on: ${values.feed}`);
        })();
// How long the feed runs before the steady phase, so its first frames (the
// lane's setup) are not scored.
const FEED_SETTLE_MS = 3000;
// The share of its ceiling a moving feed must draw at: frames are spaced, so
// a feed drawing on every beat lands a frame or two short of the ceiling.
const FEED_PACE_SHARE = 0.95;
// How far the statusline's p90 may rise with a feed open: the epic's
// criterion.
const FEED_P90_RATIO = 2;
// How often the steady phase clicks: a person opening and closing a menu.
const CLICK_PERIOD_MS = 1000;
// [LAW:parse-dont-validate] The feed-off run the `on` run is judged against:
// its statusline `took=` p90, read once from its own output.
const BASELINE_P90: number | null =
  values.baseline === undefined
    ? null
    : (() => {
        if (FEED !== "on") throw new Error("--baseline judges a --feed on run");
        const base = JSON.parse(fs.readFileSync(values.baseline, "utf8")) as {
          facts: {
            feed: { world: string } | null;
            daemonRenderMs: { took: { p90: number } };
          };
        };
        if (base.facts.feed?.world !== "off") {
          throw new Error(
            `--baseline is not a --feed off run: ${values.baseline}`,
          );
        }
        return base.facts.daemonRenderMs.took.p90;
      })();
// An active session writes a turn to its transcript every few refreshes, and
// stages a file (its git index changes) less often.
const TURN_EVERY = 4;
const STAGE_EVERY = 8;
// And now and then switches branch.
const BRANCH_EVERY = 64;
// A long session's transcript: ~5000 lines.
const TRANSCRIPT_TURNS = 1700;
// When turn `t` happened: the seeded history runs back from now, 20 s a turn.
const turnTime = (t: number): Date =>
  new Date(Date.now() - Math.max(0, TRANSCRIPT_TURNS - t) * 20_000);
// A cold daemon builds every session's state at once; each session must have
// answered once by then.
const WARM_DEADLINE_MS = 30_000;
// A session is warm once it has answered twice: what its first answer set in
// motion (its lane's setup) has landed by its second, so the steady phase's
// first sample holds what the steady phase keeps.
const WARM_ANSWERS = 2;
const SAMPLE_MS = 5000;
const INSPECTOR_CALL_MS = 30_000;
// What the charge may grow by across the steady phase, beyond a heap's
// sawtooth: the live daemon's climb is ~80 MB a minute.
const CLIMB_LIMIT_BYTES = 32 * 1024 * 1024;
// What these sessions may be charged once V8 has collected: a fifth over the
// daemon's base and each session's part, as measured at their peaks on CI
// (~174 MB at 20 sessions, ~420 MB at 100) — ~506 MB at 100. Under load the
// charge adds the garbage V8 lets the old generation hold before collecting,
// which it sizes from measured GC and mutator speed: one build's peak lands in
// either of two modes ~15 MB apart by the runner's timing, so a budget on it
// judges the runner. The shipped limit is sized for the backstop, and judging
// by it would pass a daemon nearly twice as heavy.
// [LAW:one-source-of-truth] Derived from the sessions run, so the budget is
// always these sessions'.
const BUDGET_BYTES = 1.2 * (112 + 3.1 * SESSIONS) * 1024 * 1024;
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
// The feed's world moves: an effect animates the bar, and the statusline lane
// is on, so a feed has frames to push.
const config = fs.readFileSync(path.join(FIXTURES, "config.json5"), "utf8");
fs.writeFileSync(
  path.join(dirs.config, "cc-candybar", "config.json5"),
  FEED === null
    ? config
    : config.replace(
        "{",
        '{ globals: { effect: "sparkle", experimentalStatusline: true },',
      ),
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
  answers: number;
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
  const transcript = transcriptPath(dirs.claude, checkout, id);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(
    transcript,
    Array.from({ length: TRANSCRIPT_TURNS }, (_, t) =>
      transcriptTurn(id, checkout, t, turnTime(t)),
    ).join(""),
  );
  return { index, id, checkout, transcript, ticks: 0, answers: 0 };
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
  // The banner, until its URL is read; nothing after it is kept.
  let banner: string | null = "";
  daemon.stderr.on("data", (chunk: Buffer) => {
    if (banner !== null) {
      banner += chunk.toString();
      const url = /Debugger listening on (ws:\S+)/.exec(banner)?.[1];
      if (url !== undefined) {
        banner = null;
        resolve(url);
      }
    }
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
const terminalEnv = sessionEnv(dirs.claude);
const client = nodeClientHint("node", BUNDLE);

interface Render {
  readonly phase: "warm" | "steady" | "after";
  // Which session asked, and when it did, in milliseconds since its phase
  // began: what a failed render is found by in the daemon's log.
  readonly session: number;
  readonly atMs: number;
  readonly ms: number;
  // The client's own outcome: ok, or its failure class.
  readonly outcome: string;
}
const renders: Render[] = [];
// Every session's timer: stopped when the run ends, however it ends, before
// anything removes what the sessions write into.
const timers: NodeJS.Timeout[] = [];
const stopSessions = (): void => timers.forEach((t) => clearInterval(t));
let phase: Render["phase"] = "warm";
// When the phase began: a render's offset is measured from it.
let phaseStarted = Date.now();
function enter(next: Render["phase"]): void {
  phase = next;
  phaseStarted = Date.now();
}
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
        transcriptTurn(
          s.id,
          s.checkout,
          TRANSCRIPT_TURNS + s.ticks,
          turnTime(TRANSCRIPT_TURNS + s.ticks),
        ),
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
  const atMs = Date.now() - phaseStarted;
  const t0 = performance.now();
  const done = (async () => {
    let outcome: string;
    try {
      const rendered = await tryRenderViaDaemon(
        hookData(s),
        [BUNDLE],
        s.checkout,
        {
          ...detectClientHints(terminalEnv, s.checkout, {
            columns: 160,
            rows: 48,
          }),
          client,
        },
      );
      outcome =
        rendered.kind === "ok" ? "ok" : `${rendered.kind}/${rendered.cause}`;
      if (rendered.kind === "ok") s.answers++;
    } catch (e) {
      // [LAW:no-silent-failure] A client path that throws is a failed render,
      // scored like any other, never a gate that ends without a verdict.
      outcome = `threw/${e instanceof Error ? e.message : String(e)}`;
    }
    renders.push({
      phase: rendering,
      session: s.index,
      atMs,
      ms: performance.now() - t0,
      outcome,
    });
  })();
  inFlight.add(done);
  void done.finally(() => inFlight.delete(done));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The clicks the steady phase made, as the URL handler makes them: their
// round trip and how each ended.
interface Click {
  readonly ms: number;
  readonly outcome: string;
}
const clicks: Click[] = [];

// One click on a session's 🍫, opening its settings menu or closing it, made
// as the URL handler makes it — through the handler's own parse and client —
// and how it ended.
async function menuClick(s: Session, open: boolean): Promise<string> {
  const { verb, value } = parseHandlerUrl(
    effectsUrl([
      {
        verb: VERB_SET_STATE,
        args: [s.id, "candybar.menu", open ? "open" : DISCLOSURE_CLOSED],
      },
    ]),
  );
  try {
    const clicked = await tryClickViaDaemon(verb, value);
    return clicked.kind === "ok" ? "ok" : `${clicked.kind}/${clicked.cause}`;
  } catch (e) {
    // [LAW:no-silent-failure] A click path that throws is a failed click.
    return `threw/${e instanceof Error ? e.message : String(e)}`;
  }
}

// One session's settings menu, opened and closed on a beat over the steady
// phase. A click that answers late runs the next at once, so a slow daemon is
// clicked as often, never less. The phase ends on a close, so the menu is left
// as the clicks found it.
async function clickMenu(s: Session, started: number): Promise<void> {
  let answered = s.answers;
  for (let n = 0; n % 2 === 1 || Date.now() - started < STEADY_MS; n++) {
    const t0 = performance.now();
    const outcome = await menuClick(s, n % 2 === 0);
    clicks.push({ ms: performance.now() - t0, outcome });
    answered = s.answers;
    // The next beat, or the steady phase's end if that comes first: the
    // phase's daemon events are read up to when the last click answered.
    await sleep(
      Math.min(started + (n + 1) * CLICK_PERIOD_MS, started + STEADY_MS) -
        Date.now(),
    );
  }
  // The last close's release lands with the bar's next draw, which the
  // samples after the phase must count.
  await redrawn(s, answered);
}

// Until the session draws its bar again after a click answered, when it had
// `answered`: the draw that builds what an open menu reads, or releases it
// once closed.
async function redrawn(s: Session, answered: number): Promise<void> {
  const deadline = Date.now() + WARM_DEADLINE_MS;
  while (s.answers === answered) {
    if (Date.now() >= deadline)
      throw new Error(`${s.id} drew no bar after its menu was clicked`);
    await sleep(50);
  }
}

// The menu drawn once open and once closed before the steady phase: what an
// open menu builds on its first draw it holds from then on, so the steady
// phase's first sample already counts it, and the clicks are judged by what
// they keep beyond it.
async function warmMenu(s: Session): Promise<void> {
  for (const open of [true, false]) {
    const outcome = await menuClick(s, open);
    if (outcome !== "ok")
      throw new Error(`the warm-up click on ${s.id}'s menu ended ${outcome}`);
    await redrawn(s, s.answers);
  }
}

interface Sample {
  // Under the steady load, or the reading once it has stopped.
  readonly phase: Render["phase"];
  readonly at: number;
  readonly stats: StatsSnapshot;
  readonly charge: number;
}
const samples: Sample[] = [];
// A daemon too busy to answer stats inside the stats client's budget.
const unanswered: string[] = [];
const charge = (pid: number) => chargeProbe(processLauncher, process.platform, pid);

async function sample(started: number): Promise<void> {
  // [LAW:no-ambient-temporal-coupling] The phase and offset of the instant the
  // sample was asked for, not of whatever phase holds once it is answered.
  const at = Date.now() - started;
  const asked = phase;
  const outcome = await fetchStats();
  if (outcome.kind !== "ok") {
    unanswered.push(`${at} ms: ${outcome.kind}/${outcome.cause}`);
    return;
  }
  const reading = await charge(outcome.value.pid)(outcome.value.rssBytes);
  samples.push({
    phase: asked,
    at,
    stats: outcome.value,
    charge: reading.bytes,
  });
}

// The daemon's heap once everything unreachable is collected, through its
// inspector. A heap read between collections is mostly garbage V8 has not
// yet had reason to collect.
async function liveHeap(): Promise<number> {
  // An inspector that never printed its URL is said, not waited on.
  let noUrl: NodeJS.Timeout | undefined;
  const url = await Promise.race([
    inspectorUrl,
    new Promise<never>((_, reject) => {
      noUrl = setTimeout(
        () => reject(new Error("daemon printed no inspector URL")),
        INSPECTOR_CALL_MS,
      );
    }),
  ]).finally(() => clearTimeout(noUrl));
  const ws = new WebSocket(url);
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

  enter("warm");
  sessions.forEach((s) =>
    timers.push(
      setTimeout(
        () => {
          tick(s);
          timers[s.index] = setInterval(() => tick(s), SESSION_PERIOD_MS);
        },
        (s.index * SESSION_PERIOD_MS) / SESSIONS,
      ),
    ),
  );
  const warmStarted = Date.now();
  while (
    !sessions.every((s) => s.answers >= WARM_ANSWERS) &&
    Date.now() - warmStarted < WARM_DEADLINE_MS
  ) {
    await sleep(50);
  }
  const warmMs = Date.now() - warmStarted;
  // Counted at the deadline: a session that first answers during the
  // collection below answered late.
  const silent = sessions.filter((s) => s.answers === 0).length;
  await warmMenu(sessions[0]!);
  // Before the steady phase, so no scored render waits on the collection.
  const heapBefore = await liveHeap();
  // [LAW:no-ambient-temporal-coupling] The sessions tick on through the
  // collection, and the daemon drains what they queued once it ends, so a
  // render asked right after would wait behind that backlog and run out its
  // budget. The steady phase begins once every session has been answered
  // again inside the client's budget: an answer in budget means the queue
  // ahead of it was shorter than the budget, and the daemon serves faster
  // than the sessions ask, so from there the queue only shrinks. A session
  // not answered by the deadline is scored by the steady renders it fails,
  // as the warm phase scores one, never a run without a verdict.
  const collected = sessions.map((s) => s.answers);
  const resumeStarted = Date.now();
  while (
    !sessions.every((s, i) => s.answers > collected[i]!) &&
    Date.now() - resumeStarted < WARM_DEADLINE_MS
  ) {
    await sleep(50);
  }
  const resumeMs = Date.now() - resumeStarted;

  // [LAW:dataflow-not-control-flow] The feed is one session's subscriber,
  // opened only in the `on` world; its frames are counted over the steady
  // phase alone.
  let feedFrames = 0;
  let feedEnd: StreamEnd | null = null;
  const stream =
    FEED === "on"
      ? openFrameStream(
          socket,
          sessions[0]!.id,
          "statusline",
          () => feedFrames++,
          (end) => {
            feedEnd = end;
          },
        )
      : null;
  if (stream !== null) await sleep(FEED_SETTLE_MS);
  const feedFramesBefore = feedFrames;

  enter("steady");
  const steadyStarted = phaseStarted;
  // The first sample precedes the first click: the reading the clicks'
  // subscriptions are judged to return to.
  await sample(steadyStarted);
  const clicking = clickMenu(sessions[0]!, steadyStarted);
  // The gate's own event loop: a render it measured late may be its own lag.
  const gateLoop = monitorEventLoopDelay({ resolution: 5 });
  gateLoop.enable();
  while (Date.now() - steadyStarted < STEADY_MS) {
    await sleep(SAMPLE_MS);
    await sample(steadyStarted);
  }
  gateLoop.disable();
  await clicking;
  const steadyEnded = Date.now();
  const feedFramesSteady = feedFrames - feedFramesBefore;
  // The second reading under the load the first was taken under: the steady
  // renders settle, and those the collection delays are not scored.
  enter("after");
  await Promise.all(inFlight);
  const heapAfter = await liveHeap();
  stopSessions();
  await Promise.all(inFlight);
  // The first and last samples each follow a collection.
  await sample(steadyStarted);
  // After the last sample: a feed closing is a view's observers going, which
  // the held counts would read as churn.
  stream?.close();
  // The feed's closing summary: what it drew over its whole life, and its
  // ceiling.
  const feedClosed = stream === null ? null : await feedSummary("closed");
  if (samples.length === 0) {
    throw new Error(
      `the daemon answered no stats sample: ${unanswered.join("; ")}`,
    );
  }

  const limit = memoryLimitBytes(env);
  const steady = renders.filter((r) => r.phase === "steady");
  // [LAW:nothing-unseen] Each failed steady render, by session and offset, in
  // the order asked: a hold of the daemon's thread is found in its log as a
  // gap at that instant.
  const steadyFailures = steady
    .filter((r) => r.outcome !== "ok")
    .map(({ session, atMs, outcome }) => ({ session, atMs, outcome }))
    .sort((a, b) => a.atMs - b.atMs);
  const failures = tally(steadyFailures.map((r) => r.outcome));
  const expected = (SESSIONS * STEADY_MS) / SESSION_PERIOD_MS;
  const charges = samples.map((s) => s.charge);
  // The charge read after the final collection and the drain of the sessions'
  // last renders, with every session's state still held: what these sessions
  // cost, without the garbage V8 lets the old generation hold under load. The
  // drain's own garbage is small beside that headroom. A run whose reading
  // went unanswered has none, and fails here as well as on its own check.
  const chargeAfterCollection =
    samples.find((s) => s.phase === "after")?.charge ?? null;
  const climb = heapAfter - heapBefore;
  const first0 = samples[0]!.stats;
  // The charge under load, over the steady phase's second half: in the first
  // the allocator is still filling to the load's working set, and a leak keeps
  // climbing after it is full. Charge less V8's heap is no measure of native
  // memory: the heap gives back pages it never touched, which the charge never
  // counted, so the difference grows as the heap shrinks.
  const underLoad = samples
    .filter((s) => s.phase === "steady")
    .map((s) => s.charge);
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
    watchers: held((s) => s.watchers.active),
  };
  const pids = [...new Set(samples.map((s) => s.stats.pid))];
  const postMortems = last.daemon.postMortems;
  const unknown = fs.existsSync(unknownCalls)
    ? [...new Set(fs.readFileSync(unknownCalls, "utf8").trim().split("\n"))]
    : [];
  const ms = steady.map((r) => r.ms).sort((a, b) => a - b);
  const daemon = await daemonEvents(steadyStarted, steadyEnded);
  const daemonRenderMs = {
    took: spreadOf(daemon, "render", "took"),
    queued: spreadOf(daemon, "render", "queued"),
    waited: spreadOf(daemon, "render", "waited"),
  };
  const daemonClickMs = {
    took: spreadOf(daemon, "click", "took"),
    queued: spreadOf(daemon, "click", "queued"),
  };
  const clickFailures = tally(
    clicks.filter((c) => c.outcome !== "ok").map((c) => c.outcome),
  );
  const expectedClicks = STEADY_MS / CLICK_PERIOD_MS;
  const clickMs = clicks.map((c) => c.ms).sort((a, b) => a - b);

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
      // The first few failures by name; the facts carry every one.
      detail: `${steady.length} renders (~${Math.round(expected)} asked), failures ${JSON.stringify(failures)}${steadyFailures
        .slice(0, 5)
        .map((f) => `s${f.session} at ${f.atMs} ms ${f.outcome}`)
        .map((f, i) => (i === 0 ? `: ${f}` : `, ${f}`))
        .join("")}`,
    },
    {
      // The client's own budget is the verdict: a click past it is a timeout.
      name: "steady clicks",
      pass:
        clicks.length >= expectedClicks * 0.9 &&
        Object.keys(clickFailures).length === 0,
      detail: `${clicks.length} clicks (~${expectedClicks} made), failures ${JSON.stringify(clickFailures)}`,
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
      name: "charge once collected within the budget",
      pass:
        chargeAfterCollection !== null && chargeAfterCollection <= BUDGET_BYTES,
      detail: `${chargeAfterCollection === null ? "no reading after the collection" : `${mb(chargeAfterCollection)} MB`} of ${mb(BUDGET_BYTES)} MB, ${underLoad.length === 0 ? "no reading under load" : `${mb(Math.max(...underLoad))} MB at most under load`} (limit ${mb(limit)} MB)`,
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
      // [LAW:verifiable-goals] An open menu draws rows that read session
      // state, so its observers rise and fall with the clicks; what the
      // clicks must not do is keep any. Once they leave the menu as they
      // found it, the count is back to its reading before the first.
      name: "click subscriptions released",
      pass: last.sessionState.observers === first0.sessionState.observers,
      detail: `${first0.sessionState.observers} state observers before the first click, ${last.sessionState.observers} after the last`,
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
    // [LAW:dataflow-not-control-flow] The feed's checks, in the world that
    // opens one; the p90 check where a baseline was given to judge by.
    ...(feedClosed === null ? [] : [feedPaceCheck(feedClosed)]),
    ...(BASELINE_P90 === null
      ? []
      : [
          {
            name: "statusline p90 within 2x of the feed-off baseline",
            pass: daemonRenderMs.took.p90 <= FEED_P90_RATIO * BASELINE_P90,
            detail: `took p90 ${daemonRenderMs.took.p90} ms with the feed, ${BASELINE_P90} ms without (limit ${FEED_P90_RATIO}x)`,
          },
        ]),
  ];
  const facts = {
    sessions: SESSIONS,
    steadySeconds: STEADY_MS / 1000,
    warmMs,
    // Until every session was answered again after the collection, capped
    // at the warm deadline: at the cap, the backlog never drained.
    resumeMs,
    warmRenders: tally(
      renders.filter((r) => r.phase === "warm").map((r) => r.outcome),
    ),
    steadyRenders: steady.length,
    // When the steady phase began, as the daemon's log stamps its lines: a
    // failure's offset is added to it to find the instant there.
    steadyStartedAt: new Date(steadyStarted).toISOString(),
    steadyFailures,
    steadyMs: {
      p50: pct(ms, 0.5),
      p90: pct(ms, 0.9),
      p99: pct(ms, 0.99),
      max: ms.at(-1) ?? 0,
    },
    chargeMb: charges.map(mb),
    // The charge the budget judges, by name.
    chargeAfterCollectionMb:
      chargeAfterCollection === null ? null : mb(chargeAfterCollection),
    limitMb: mb(limit),
    rssMb: samples.map((s) => mb(s.stats.rssBytes)),
    heapUsedMb: samples.map((s) => mb(s.stats.heapUsedBytes)),
    heapTotalMb: samples.map((s) => mb(s.stats.heapTotalBytes)),
    // How long each steady render was queued in the daemon before it began,
    // how long it then waited for its refreshes and how long it took in all,
    // from its own render events, beside the gate's lag: a slow round trip is
    // one of these.
    daemonRenderMs,
    // The steady clicks' round trips, and what the daemon took over each from
    // its click events.
    clickMs: {
      p50: pct(clickMs, 0.5),
      p90: pct(clickMs, 0.9),
      max: clickMs.at(-1) ?? 0,
    },
    daemonClickMs,
    gateLoopDelayMs: {
      p99: Math.round(gateLoop.percentile(99) / 1e6),
      max: Math.round(gateLoop.max / 1e6),
    },
    renderCache: last.renderCache,
    requests: last.requests,
    // The frames the feed's subscriber received over the steady phase, how
    // its stream ended (null while open), and the feed's own summary lines.
    feed:
      FEED === null
        ? null
        : {
            world: FEED,
            frames: feedFramesSteady,
            fps: +(feedFramesSteady / (STEADY_MS / 1000)).toFixed(1),
            end: feedEnd,
            closed: feedClosed,
          },
    loadAverage: os.loadavg().map((x) => +x.toFixed(2)),
  };
  return { checks, facts };
}

// The feed's summary line in `state`, once the daemon has written it.
async function feedSummary(state: "closed"): Promise<string> {
  for (const giveUp = Date.now() + 10_000; Date.now() < giveUp; ) {
    const line = logLines(logPath(env)).find(
      (l) => l.includes("] feed sid=") && l.includes(` ${state} `),
    );
    if (line !== undefined) return line;
    await sleep(200);
  }
  throw new Error(`the feed wrote no ${state} summary within 10 s`);
}

// [LAW:verifiable-goals] The feed's world moves every moment (an effect), so
// a feed holds its pace when the rate it drew at over its life, as its
// summary states it, is its ceiling: the most frames a second it may draw.
// [LAW:no-silent-failure] A field the summary does not state fails the gate
// by name, never as a comparison against NaN.
function feedPaceCheck(summary: string): Check {
  const field = (name: string): number => {
    const value = new RegExp(` ${name}=([\\d.]+)`).exec(summary)?.[1];
    if (value === undefined)
      throw new Error(`the feed summary states no ${name}=: ${summary}`);
    return Number(value);
  };
  const achieved = field("achieved");
  const ceiling = field("ceiling");
  return {
    name: "feed holds its pace",
    pass: achieved >= FEED_PACE_SHARE * ceiling,
    detail: `drew ${field("drawn")} frames in ${field("for")} s at ${achieved} fps of its ${ceiling} fps ceiling (at least ${FEED_PACE_SHARE * 100}%)`,
  };
}

// The events the daemon wrote in the window: what it took over every render
// and click it finished there. It writes its log off its event loop, in
// order, through one writer, so the window's last events have landed once any
// line after the window has.
async function daemonEvents(since: number, until: number): Promise<string[]> {
  const log = logPath(env);
  const stamped = (): Array<{ at: number; line: string }> =>
    logLines(log).map((line) => ({ at: Date.parse(line.slice(0, 24)), line }));
  let all = stamped();
  for (
    const giveUp = Date.now() + 10_000;
    !all.some(({ at }) => at > until) && Date.now() < giveUp;
  ) {
    await sleep(200);
    all = stamped();
  }
  return all
    .filter(
      ({ at, line }) => at >= since && at <= until && line.includes(" took="),
    )
    .map(({ line }) => line);
}

// One field's spread over the window's events of one kind, in ms.
interface Spread {
  readonly n: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
}

function spreadOf(
  lines: readonly string[],
  event: "render" | "click",
  field: string,
): Spread {
  const ms = lines
    .filter((l) => l.includes(`] ${event} `))
    .map((l) => Number(new RegExp(` ${field}=(\\d+)ms`).exec(l)?.[1]))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    n: ms.length,
    p50: pct(ms, 0.5),
    p90: pct(ms, 0.9),
    p99: pct(ms, 0.99),
    max: ms.at(-1) ?? 0,
  };
}

function tally(xs: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}
function pct(sorted: readonly number[], p: number): number {
  return sorted.length === 0 ? 0 : Math.round(percentile(sorted, p));
}

// [LAW:no-silent-failure] Every way out is a verdict: a crash fails, and a
// failing run keeps its root (the daemon's log is in it) and says where.
// A gate that hangs (a daemon that stopped answering its inspector, a render
// that never settles) ends here, with its root kept, before CI cancels it.
// Counted from the process's start, the fixture's building included: the
// steady phase asked for, and two minutes for everything around it (under one
// minute measured at 100 sessions).
// [LAW:one-source-of-truth] Derived from the steady phase, so a longer run
// asked for is a longer deadline, never a failure.
const GATE_DEADLINE_MS = STEADY_MS + 2 * 60_000;
let passed = false;
try {
  const { checks, facts } = await Promise.race([
    run(),
    sleep(GATE_DEADLINE_MS - performance.now()).then(() => {
      throw new Error(`the gate ran past its ${GATE_DEADLINE_MS / 1000} s`);
    }),
  ]);
  passed = checks.every((c) => c.pass);
  for (const c of checks)
    console.error(`${c.pass ? "pass" : "FAIL"}  ${c.name}: ${c.detail}`);
  console.log(JSON.stringify({ pass: passed, checks, facts }));
} catch (e) {
  console.error(`FAIL  ${e instanceof Error ? e.message : String(e)}`);
} finally {
  stopSessions();
  // The daemon ends through its own shutdown, so its log holds every line it
  // logged, and is killed if it does not; the root goes once nothing writes
  // into it.
  const gone = new Promise((resolve) => daemon.once("exit", resolve));
  if (daemonExit === null) {
    daemon.kill("SIGTERM");
    await Promise.race([gone, sleep(3000)]);
  }
  if (daemonExit === null) {
    daemon.kill("SIGKILL");
    await Promise.race([gone, sleep(3000)]);
  }
  // [LAW:no-silent-failure] A removal that fails is said, and the verdict
  // still stands.
  const remove = (dir: string) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.error(`could not remove ${dir}: ${(e as Error).message}`);
    }
  };
  if (passed) remove(root);
  else {
    // The checkouts and transcripts are the fixture, half a gigabyte of it;
    // the daemon's state (its log) is the diagnosis.
    remove(dirs.checkouts);
    remove(dirs.claude);
    console.error(`kept ${root} (daemon log: ${logPath(env)})`);
  }
}
process.exit(passed ? 0 : 1);
