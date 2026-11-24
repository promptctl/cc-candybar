// capture-heap.ts — the built daemon serving N sessions, its memory read at
// each stage and its heap written to a snapshot.
//
// WHY THIS EXISTS
// ---------------
// Splitting the daemon into Gather (reads the world) and Renderers (draw it)
// needs to know what each half costs. The load gate measures the charge but
// writes no snapshot, and the daemon writes one only when it breaches. This
// drives the same world the benchmarks use and asks for a snapshot by signal.
//
// What it answers, and what it does not:
// - The cost of a session's sources is the difference between two runs at one
//   population, one on the bundled config and one on `--config` a config that
//   draws only hook data. That is a lower bound on the reading side: a source
//   the config does not gate (a repository's cache and watchers) stays.
// - Which half a heap object belongs to is NOT answered by reachability from
//   each half's root objects. Every closure's context reaches module scope, so
//   following contexts makes every byte shared and skipping them makes the
//   reading side look empty. A session's source values live in the drawing
//   side's variable store, which is why they are shared state, not a part of
//   either half.
// - Class names survive only in an unminified bundle (`pnpm exec tsdown
//   --no-minify`); the shipped bundle's are mangled.
//
// USAGE
//   pnpm build && node --require ./scripts/lib/version-stamp.cjs --import tsx \
//     scripts/capture-heap.ts [--sessions N] [--turns T] [--config FILE] [--out DIR]
//
// Prints one JSON object: the footprint of the host and of each renderer
// process at each stage, the host's heap and footprint after the snapshot,
// what the daemon says it holds, and the snapshot's path. The snapshot is the
// host's alone: the signal goes to the host, so a renderer's heap is read
// only as its footprint and its panel. A stage's footprint is read without a
// collection first, so it includes garbage V8 has not yet had reason to free. `collected.heapUsedMb` is read
// after the snapshot, which V8 collects before taking; `collected.physFootprintMb`
// is not a measurement of the daemon, because the snapshot's own buffers are
// still charged to it. Size a budget from the load gate's "charge once
// collected".

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { startWorld, type Session } from "./bench/world.js";
import type { StatsSnapshot } from "../src/daemon/foundations/stats-snapshot.js";
import { sleep } from "./bench/measure.js";
import { BYTES_PER_MB, mb } from "../src/daemon/foundations/memory-limit.js";
import { physFootprintsOf } from "../src/daemon/memory-report.js";

const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "100" },
    turns: { type: "string", default: "1700" },
    out: { type: "string", default: "/tmp/cc-candybar-heap" },
    // The config the daemon serves. A config that draws nothing a source
    // feeds (one segment of hook data) starts no source, so the difference
    // between two runs at one population is what the sources cost.
    config: { type: "string" },
  },
});
const SESSIONS = Number(values.sessions);
const TURNS = Number(values.turns);
if (process.platform !== "darwin") {
  // The charge is read from `footprint`, which only macOS has; on Linux the
  // charge is RSS and nothing here reads it.
  throw new Error(
    `capture-heap reads /usr/bin/footprint and runs on macOS only`,
  );
}
if (
  !Number.isInteger(SESSIONS) ||
  SESSIONS < 1 ||
  !Number.isInteger(TURNS) ||
  TURNS < 0
) {
  // Zero turns is a real measurement: sessions with no history.
  throw new Error(
    `--sessions must be a positive integer and --turns a non-negative one`,
  );
}

const COLUMNS = 160;
// A checkout of the size the benchmarks' wire suite draws from.
const CHECKOUT = { files: 200, commits: 20, modified: 8, untracked: 4 };
// Sessions settled at once: a client's own pace is a tick a second per
// session, and the daemon is not asked for more than a hundred of those.
const BATCH = 10;
const STAGES = [0, 1, 10, SESSIONS].filter(
  (n, i, all) => n <= SESSIONS && all.indexOf(n) === i,
);
// How long the daemon is given to write a snapshot of a heap this size.
const SNAPSHOT_WAIT_MS = 120_000;

// A directory of this run's own: a snapshot found in it is this run's, never
// a previous run's left under the same --out.
fs.mkdirSync(path.resolve(values.out!), { recursive: true });
const OUT = fs.mkdtempSync(path.join(path.resolve(values.out!), "run-"));

// `footprint -p` prints the process's whole table, categories included; the
// charge is its phys_footprint line, read as the backstop reads it. Kept whole
// so the native share (what a heap snapshot cannot see) is read from the
// daemon's own accounting.
function footprint(pid: number): { physFootprintMb: number; table: string } {
  const table = execFileSync(
    "/usr/bin/footprint",
    ["-p", String(pid), "-f", "bytes"],
    { encoding: "utf8" },
  );
  const bytes = physFootprintsOf(table).byPid.get(pid);
  if (bytes === undefined)
    throw new Error(`footprint printed no phys_footprint for pid ${pid}`);
  return { physFootprintMb: bytes / BYTES_PER_MB, table };
}

// Every process the daemon runs, each its own footprint: the host, and each
// renderer its panel says runs in a process of its own.
function footprints(stats: StatsSnapshot) {
  return {
    host: footprint(stats.pid),
    renderers: stats.renderers.flatMap(({ name, process }) =>
      process.kind === "process"
        ? [{ name, pid: process.memory.pid, ...footprint(process.memory.pid) }]
        : [],
    ),
  };
}

function endsWithBrace(file: string, size: number): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const tail = Buffer.alloc(Math.min(size, 16));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return tail.toString("utf8").trimEnd().endsWith("}");
  } finally {
    fs.closeSync(fd);
  }
}

const world = await startWorld(
  values.config === undefined ? "{}\n" : fs.readFileSync(values.config, "utf8"),
  {
    NODE_OPTIONS: `--heapsnapshot-signal=SIGUSR2 --diagnostic-dir=${OUT}`,
  },
);
try {
  const pid = (await world.stats()).pid;
  const stages: unknown[] = [];
  const sessions: Session[] = [];
  const read = async (n: number): Promise<void> => {
    const s = await world.stats();
    const { host, renderers } = footprints(s);
    stages.push({
      sessions: n,
      host: {
        ...host,
        rssMb: mb(s.rssBytes),
        heapUsedMb: mb(s.heapUsedBytes),
      },
      renderers,
    });
  };
  await read(0);
  for (const stage of STAGES.filter((n) => n > 0)) {
    const fresh: Session[] = [];
    while (sessions.length + fresh.length < stage) {
      const i = sessions.length + fresh.length;
      fresh.push(world.session(`s${i}`, CHECKOUT, TURNS));
    }
    for (let i = 0; i < fresh.length; i += BATCH) {
      await Promise.all(
        fresh.slice(i, i + BATCH).map((s) => world.settle(s, COLUMNS)),
      );
    }
    sessions.push(...fresh);
    await sleep(3000);
    await read(stage);
  }

  process.kill(pid, "SIGUSR2");
  const deadline = Date.now() + SNAPSHOT_WAIT_MS;
  // V8 streams the file under its final name, so a file is whole when its
  // size has stopped moving and it ends with the JSON's closing brace.
  let snapshot: string | undefined;
  let lastSize = -1;
  while (snapshot === undefined) {
    // Named for the pid that wrote it: the daemon's snapshot, whatever else
    // the world runs.
    const found = fs
      .readdirSync(OUT)
      .find((f) => f.endsWith(".heapsnapshot") && f.includes(`.${pid}.`));
    const size =
      found === undefined ? -1 : fs.statSync(path.join(OUT, found)).size;
    if (
      found !== undefined &&
      size > 0 &&
      size === lastSize &&
      endsWithBrace(path.join(OUT, found), size)
    ) {
      snapshot = path.join(OUT, found);
    } else {
      lastSize = size;
      if (Date.now() > deadline) {
        throw new Error(
          `no whole snapshot in ${OUT} after ${SNAPSHOT_WAIT_MS} ms`,
        );
      }
      await sleep(2000);
    }
  }
  // V8 collects before it snapshots, so the heap read now is what is live.
  const after = await world.stats();
  const final = {
    sessions: SESSIONS,
    turns: TURNS,
    config: values.config ?? "(bundled default)",
    stages,
    // The host's, whose heap the snapshot collected.
    collected: {
      heapUsedMb: mb(after.heapUsedBytes),
      physFootprintMb: footprint(pid).physFootprintMb,
    },
    // What the daemon says it holds: sources started, entries kept, and each
    // renderer's own panel as it answered, or why it did not.
    held: after.sources.held,
    renderers: after.renderers,
    gitCache: after.gitCache,
    usageCache: after.usageCache,
    snapshot,
  };
  console.log(JSON.stringify(final, null, 1));
} finally {
  await world.stop();
}
