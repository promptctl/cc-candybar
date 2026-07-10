// Daemon render-latency load harness (brandon-daemon-perf-bb9).
//
// [LAW:verifiable-goals] The reproducible gate the ticket asks for: drive N
// synthetic Claude sessions at a fixed tick rate against an ISOLATED daemon
// (its own CC_CANDYBAR_SOCKET + XDG dirs, never the developer's real daemon),
// measure the per-render round-trip distribution the way the *client* sees it,
// and report p50/p95/p99/max plus a classified error count. The pass bar is the
// Rust client's own budget, not the daemon's looser internal timeout:
//   - TOTAL_BUDGET = 150ms round-trip (rust-client TOTAL_BUDGET)
//   - CONNECT_TIMEOUT = 50ms connect (rust-client CONNECT_TIMEOUT)
// A render slower than 150ms is a client give-up → stale bar → respawn, even
// though the daemon (200ms REQUEST_TIMEOUT_MS) still thinks it answered. So the
// harness gates on 150ms and reports connect-phase latency separately.
//
// [LAW:effects-at-boundaries] The harness is the world edge: it owns process
// spawn, sockets, fs, and the clock. The measured subject (the daemon) is a
// black box driven only over its wire — no in-process shortcuts, so the numbers
// mean what production means.
//
// Faithful to production in the ways that matter for this bug:
//   - ONE fresh connection per render (the Rust client connects, sends, prints,
//     exits every tick) — this is what exercises the accept backlog where the
//     storm's ECONNREFUSED/EPIPE originated.
//   - The DEFAULT bundled config (no config file) drives the real provider mix:
//     git (subprocess), session+today (transcript fold), context (transcript
//     read) — the exact per-render fs/spawn work the ticket suspects.
//   - project_dir points at a REAL git repo so git actually runs; each session
//     gets its own synthetic JSONL transcript so the usage folds do real work.
//
// Run: pnpm build && node --import tsx scripts/daemon-load-harness.ts --sessions 25
// Flags: --sessions N --interval MS --duration S --transcript-lines N
//        --churn (append a transcript line each tick → invalidation bursts)
//        --daemon dist|tsx (which daemon artifact; default dist)
//        --profile (spawn daemon under --cpu-prof; writes .cpuprofile on exit)
//        --json (emit the summary as one JSON line for regression gating)

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  makeFrameReader,
} from "../src/daemon/protocol.js";

// ─── Client budget (mirror of rust-client/src/main.rs) ──────────────────────
const CONNECT_TIMEOUT_MS = 50;
const TOTAL_BUDGET_MS = 150;

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

// ─── CLI ────────────────────────────────────────────────────────────────────
const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "25" },
    interval: { type: "string", default: "300" },
    duration: { type: "string", default: "20" },
    "transcript-lines": { type: "string", default: "800" },
    churn: { type: "boolean", default: false },
    daemon: { type: "string", default: "dist" },
    profile: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    // A config.json5 to drop into the isolated XDG_CONFIG_HOME (else the daemon
    // falls back to DEFAULT_DSL_CONFIG). Use to exercise provider mixes the
    // default layout doesn't — e.g. a metrics/burn segment.
    config: { type: "string" },
  },
});

const SESSIONS = Number(values.sessions);
const INTERVAL_MS = Number(values.interval);
const DURATION_MS = Number(values.duration) * 1000;
const TRANSCRIPT_LINES = Number(values["transcript-lines"]);

// ─── Outcome classification ─────────────────────────────────────────────────
// [LAW:types-are-the-program] Every render lands in exactly one bucket. The
// classes mirror the failures the storm logs showed, so the report answers
// "which failure mode" not just "how many failed".
interface Sample {
  totalMs: number;
  connectMs: number;
  // [LAW:types-are-the-program] connect_timeout (couldn't accept within 50ms —
  // daemon alive but its accept backlog is saturated) is a DISTINCT failure from
  // econnrefused (kernel refused — daemon not listening at all). Conflating them
  // would recreate the exact misdiagnosis that drove the storm, so the harness
  // that exists to tell failure modes apart must keep them apart.
  outcome:
    | "ok"
    | "budget_exceeded"
    | "connect_timeout"
    | "econnrefused"
    | "epipe"
    | "other";
  atMs: number; // elapsed since measurement start, for cold-start vs steady-state
}

const samples: Sample[] = [];
let runStart = 0;

// ─── One faithful render round-trip ─────────────────────────────────────────
// Mirrors the Rust client's phase budget: 50ms connect, 150ms total. Fresh
// connection per call. Resolves to a Sample; never rejects (a failure is a
// classified Sample, not an exception — the loop must not stop on one bad tick).
function oneRender(
  sockPath: string,
  hookData: unknown,
  cwd: string,
): Promise<Sample> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let connectMs = 0;
    let settled = false;
    const sock = net.connect(sockPath);
    const finish = (outcome: Sample["outcome"]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(connectTimer);
      sock.removeAllListeners();
      sock.destroy();
      resolve({
        totalMs: performance.now() - t0,
        connectMs,
        outcome,
        atMs: runStart > 0 ? performance.now() - runStart : 0,
      });
    };
    const connectTimer = setTimeout(
      () => finish("connect_timeout"),
      CONNECT_TIMEOUT_MS,
    );
    const totalTimer = setTimeout(
      () => finish("budget_exceeded"),
      TOTAL_BUDGET_MS,
    );

    sock.once("connect", () => {
      connectMs = performance.now() - t0;
      clearTimeout(connectTimer);
      const reader = makeFrameReader(
        () => finish("ok"),
        () => finish("other"),
      );
      sock.on("data", reader);
      sock.write(
        encodeFrame({
          v: PROTOCOL_VERSION,
          kind: "render",
          hookData,
          args: [],
          cwd,
          termCols: 120,
        }),
      );
    });
    sock.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") finish("econnrefused");
      else if (err.code === "EPIPE" || err.code === "ECONNRESET")
        finish("epipe");
      else finish("other");
    });
  });
}

// ─── Synthetic transcript ────────────────────────────────────────────────────
// [LAW:one-source-of-truth] The usage fold reads message.usage.* and costUSD;
// the size drives cold-parse cost. Realistic shape so the fold does real work,
// not a no-op over an empty file.
function writeTranscript(file: string, lines: number): void {
  const rows: string[] = [];
  const base = Date.parse("2026-07-09T09:00:00.000Z");
  for (let i = 0; i < lines; i++) {
    rows.push(
      JSON.stringify({
        timestamp: new Date(base + i * 1000).toISOString(),
        costUSD: 0.0125,
        message: {
          usage: {
            input_tokens: 1200,
            output_tokens: 320,
            cache_creation_input_tokens: 500,
            cache_read_input_tokens: 8000,
          },
        },
      }),
    );
  }
  fs.writeFileSync(file, rows.join("\n") + "\n");
}

function makeHookData(
  sessionId: string,
  transcriptPath: string,
  cwd: string,
  projectDir: string,
): unknown {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    hook_event_name: "Status",
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    model: { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
    workspace: { current_dir: cwd, project_dir: projectDir, added_dirs: [] },
    version: "1.17.3",
    cost: {
      total_cost_usd: 4.21,
      total_duration_ms: 1_800_000,
      total_api_duration_ms: 900_000,
      total_lines_added: 320,
      total_lines_removed: 90,
    },
    context_window: {
      total_input_tokens: 120_000,
      total_output_tokens: 18_000,
      context_window_size: 200_000,
      used_percentage: 62,
      remaining_percentage: 38,
      current_usage: {
        input_tokens: 1200,
        output_tokens: 320,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 8000,
      },
    },
    rate_limits: {
      five_hour: { used_percentage: 44, resets_at: nowSec + 3600 },
      seven_day: { used_percentage: 22, resets_at: nowSec + 5 * 86400 },
    },
  };
}

// ─── Daemon lifecycle ─────────────────────────────────────────────────────────
interface DaemonHandle {
  child: ChildProcess;
  sockPath: string;
  profileDir: string | null;
  cleanup(): void;
}

async function spawnDaemon(stateRoot: string): Promise<DaemonHandle> {
  const stateDir = path.join(stateRoot, "cc-candybar");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const sockPath = path.join(stateDir, "socket");
  // [LAW:locality-or-seam] cpuprof dir lives OUTSIDE stateRoot so the run's
  // stateRoot cleanup doesn't delete the profile the operator wants to inspect.
  const profileDir = values.profile
    ? fs.mkdtempSync(path.join(os.tmpdir(), "cbh-cpuprof-"))
    : null;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CC_CANDYBAR_SOCKET: sockPath,
    XDG_STATE_HOME: stateRoot,
    XDG_CACHE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "cbh-cache-")),
    // Empty config dir → falls back to DEFAULT_DSL_CONFIG (the realistic mix).
    XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "cbh-config-")),
  };
  if (values.config) {
    const cfgDir = path.join(env.XDG_CONFIG_HOME!, "cc-candybar");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.copyFileSync(values.config, path.join(cfgDir, "config.json5"));
  }

  const nodeFlags = profileDir
    ? ["--cpu-prof", "--cpu-prof-dir", profileDir]
    : [];
  const [cmd, args] =
    values.daemon === "tsx"
      ? [
          process.execPath,
          [
            "--import",
            "tsx",
            ...nodeFlags,
            path.join(REPO_ROOT, "src", "index.ts"),
            "daemon",
          ],
        ]
      : [
          process.execPath,
          [...nodeFlags, path.join(REPO_ROOT, "dist", "index.mjs"), "daemon"],
        ];

  const child = spawn(cmd, args, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (b: Buffer) =>
    process.stderr.write(`[daemon] ${b}`),
  );

  const cleanup = (): void => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    for (const d of [env.XDG_CACHE_HOME, env.XDG_CONFIG_HOME]) {
      if (d)
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch {}
    }
  };

  const deadline = Date.now() + 8000;
  let alive = false;
  while (!alive && Date.now() < deadline) {
    if (fs.existsSync(sockPath)) {
      alive = await new Promise<boolean>((resolve) => {
        const s = net.connect(sockPath);
        s.once("connect", () => {
          s.destroy();
          resolve(true);
        });
        s.once("error", () => resolve(false));
      });
    }
    if (!alive) await new Promise((r) => setTimeout(r, 25));
  }
  if (!alive) {
    cleanup();
    throw new Error("daemon did not accept within 8s");
  }
  return { child, sockPath, profileDir, cleanup };
}

// Request the daemon's own stats snapshot (its view of the run).
function fetchStats(sockPath: string): Promise<unknown> {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    let done = false;
    const finish = (v: unknown): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => {
      const reader = makeFrameReader(
        (f) => finish(f),
        () => finish(null),
      );
      sock.on("data", reader);
      sock.write(encodeFrame({ v: PROTOCOL_VERSION, kind: "stats" }));
    });
    sock.on("error", () => finish(null));
    setTimeout(() => finish(null), 1000);
  });
}

function shutdownDaemon(sockPath: string): Promise<void> {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve();
    };
    sock.once("connect", () => {
      const reader = makeFrameReader(
        () => finish(),
        () => finish(),
      );
      sock.on("data", reader);
      sock.write(encodeFrame({ v: PROTOCOL_VERSION, kind: "shutdown" }));
    });
    sock.on("error", () => finish());
    setTimeout(() => finish(), 2000);
  });
}

// ─── Percentiles ──────────────────────────────────────────────────────────────
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx]!;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cbh-state-"));
  const transcriptDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cbh-transcripts-"),
  );
  // [LAW:effects-at-boundaries] The caller owns these two temp dirs; a
  // spawnDaemon throw (readiness timeout) mid-run must not leak them in /tmp.
  // spawnDaemon already tears down its own child + cache/config dirs on failure;
  // this finally covers stateRoot + transcriptDir on every exit path.
  let exitCode = 1;
  try {
    // Each synthetic session: distinct id + transcript; cwd/project_dir = the real
    // repo so git actually runs.
    const sessions = Array.from({ length: SESSIONS }, (_, i) => {
      const id = `load-sess-${i}-${process.pid}`;
      const transcriptPath = path.join(transcriptDir, `${id}.jsonl`);
      writeTranscript(transcriptPath, TRANSCRIPT_LINES);
      return {
        id,
        transcriptPath,
        hookData: makeHookData(id, transcriptPath, REPO_ROOT, REPO_ROOT),
      };
    });

    const handle = await spawnDaemon(stateRoot);
    // eslint-disable-next-line no-console
    console.error(
      `daemon up (${values.daemon}${values.profile ? " +cpuprof" : ""}); ` +
        `${SESSIONS} sessions @ ${INTERVAL_MS}ms for ${DURATION_MS / 1000}s` +
        `${values.churn ? " (churn)" : ""}`,
    );

    // Warm-up: establish every session's byte cursor and let the one-time cold
    // full-read (O(transcript length), once per session per daemon lifetime) plus
    // its GC settle BEFORE measurement. Steady state — incremental O(new bytes) —
    // is what production renders are and what this gate measures; the cold read is
    // amortized over a session's hundreds of renders and must not dominate p99.
    for (let round = 0; round < 3; round++) {
      await Promise.all(
        sessions.map((s) => oneRender(handle.sockPath, s.hookData, REPO_ROOT)),
      );
    }
    await new Promise((r) => setTimeout(r, 250));

    const start = performance.now();
    runStart = start;
    const timers: NodeJS.Timeout[] = [];
    let churnCounter = 0;
    await new Promise<void>((resolveRun) => {
      for (const s of sessions) {
        const tick = setInterval(() => {
          if (values.churn) {
            // Append a line → transcript mtime bumps → next fold re-parses.
            churnCounter++;
            fs.appendFileSync(
              s.transcriptPath,
              JSON.stringify({
                timestamp: new Date().toISOString(),
                costUSD: 0.001,
                message: {
                  usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                  },
                },
              }) + "\n",
            );
          }
          void oneRender(handle.sockPath, s.hookData, REPO_ROOT).then(
            (sample) => samples.push(sample),
          );
        }, INTERVAL_MS);
        timers.push(tick);
      }
      setTimeout(() => {
        for (const t of timers) clearInterval(t);
        resolveRun();
      }, DURATION_MS);
    });
    const elapsedS = (performance.now() - start) / 1000;
    // Let any in-flight renders settle.
    await new Promise((r) => setTimeout(r, TOTAL_BUDGET_MS + 50));

    const stats = await fetchStats(handle.sockPath);

    // ─── Report ─────────────────────────────────────────────────────────────
    // [LAW:verifiable-goals] The ticket's bar is "under SUSTAINED load". A daemon's
    // first seconds pay a one-time O(transcript length) cold read per session per
    // provider (plus the GC of those transient parses) — real, but amortized over a
    // session's hundreds of renders, NOT a sustained stall. So the gate scores
    // STEADY-STATE (renders after the cold-start ramp); the ramp is reported
    // separately, never hidden. A regression that slows steady renders still trips
    // the gate; a slow cold start shows up as a large ramp count for the operator.
    const RAMP_MS = 3000;
    const steady = samples.filter((s) => s.atMs >= RAMP_MS);
    const ramp = samples.filter((s) => s.atMs < RAMP_MS);
    const totals = steady.map((s) => s.totalMs).sort((a, b) => a - b);
    const connects = samples
      .map((s) => s.connectMs)
      .filter((c) => c > 0)
      .sort((a, b) => a - b);
    const byOutcome = (o: Sample["outcome"]): number =>
      samples.filter((s) => s.outcome === o).length;
    const steadyOver = steady.filter(
      (s) => s.outcome === "budget_exceeded",
    ).length;
    const summary = {
      sessions: SESSIONS,
      intervalMs: INTERVAL_MS,
      churn: values.churn,
      transcriptLines: TRANSCRIPT_LINES,
      daemon: values.daemon,
      config: values.config ?? "default",
      elapsedS: Number(elapsedS.toFixed(1)),
      renders: samples.length,
      achievedRatePerSec: Number((samples.length / elapsedS).toFixed(1)),
      // Steady-state (post-ramp) round-trip — the sustained-load figure the gate
      // scores against the Rust client's 150ms TOTAL_BUDGET.
      steadyLatencyMs: {
        p50: Number(pct(totals, 50).toFixed(1)),
        p95: Number(pct(totals, 95).toFixed(1)),
        p99: Number(pct(totals, 99).toFixed(1)),
        max: Number((totals[totals.length - 1] ?? 0).toFixed(1)),
        renders: steady.length,
      },
      connectMs: {
        p50: Number(pct(connects, 50).toFixed(1)),
        p99: Number(pct(connects, 99).toFixed(1)),
        max: Number((connects[connects.length - 1] ?? 0).toFixed(1)),
      },
      outcomes: {
        ok: byOutcome("ok"),
        budget_exceeded: byOutcome("budget_exceeded"),
        connect_timeout: byOutcome("connect_timeout"),
        econnrefused: byOutcome("econnrefused"),
        epipe: byOutcome("epipe"),
        other: byOutcome("other"),
      },
      // The one-time startup ramp (first RAMP_MS): its render count and how many of
      // those exceeded budget. Large numbers here mean slow cold reads, not a
      // sustained-load regression.
      coldStart: {
        rampMs: RAMP_MS,
        renders: ramp.length,
        overBudget: ramp.filter((s) => s.outcome === "budget_exceeded").length,
      },
      // Timestamps (ms since measurement start) of any STEADY over-budget render —
      // spread ⇒ a real periodic stall to chase; isolated/absent ⇒ scheduler noise.
      steadyOverAtMs: steady
        .filter((s) => s.outcome === "budget_exceeded")
        .map((s) => Math.round(s.atMs)),
      churnAppends: churnCounter,
      budgetMs: TOTAL_BUDGET_MS,
      // Pass = the ticket's acceptance under SUSTAINED load: steady p99 within the
      // client budget, zero steady over-budget, and zero connection failures at any
      // point — a saturated backlog (connect_timeout), a refused socket, or a
      // broken pipe are each unacceptable, ramp or not.
      pass:
        pct(totals, 99) <= TOTAL_BUDGET_MS &&
        steadyOver === 0 &&
        byOutcome("epipe") === 0 &&
        byOutcome("connect_timeout") === 0 &&
        byOutcome("econnrefused") === 0,
    };

    if (values.json) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ summary, daemonStats: stats }));
    } else {
      // eslint-disable-next-line no-console
      console.log("\n─── load-harness summary ───");
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(summary, null, 2));
    }

    if (handle.profileDir) {
      await shutdownDaemon(handle.sockPath);
      await new Promise((r) => setTimeout(r, 500));
      const profiles = fs.existsSync(handle.profileDir)
        ? fs.readdirSync(handle.profileDir)
        : [];
      // eslint-disable-next-line no-console
      console.error(
        `cpu profiles: ${profiles.map((p) => path.join(handle.profileDir!, p)).join(", ")}`,
      );
    }

    handle.cleanup();
    exitCode = summary.pass ? 0 : 1;
  } finally {
    try {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(transcriptDir, { recursive: true, force: true });
    } catch {}
  }
  process.exit(exitCode);
}

void main();
