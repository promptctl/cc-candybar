// [LAW:verifiable-goals] The daemon RSS leak (epic brandon-daemon-memory-leak-gn4)
// must have a deterministic, machine-verifiable reproduction BEFORE any fix —
// past attempts failed by speculating. This file encodes the success/failure
// shape and pins it so the leak cannot silently return.
//
// WHAT THE LEAK IS (verified via heap snapshots — see ticket 5qh)
// --------------------------------------------------------------
// The transcript-scanning provider path (`loadEntriesFromProjects`, since
// removed) fanned out an UNBOUNDED `Promise.all` over every transcript file on
// every cache-miss render.
// At the OOM trigger ~3046 `FSReqPromise` were held DIRECTLY by libuv's pending-
// request table — i.e. that many fs syscalls in flight at once. The JS heap was
// 36 MB while RSS was 250 MB; the gap is native libuv request + read buffers.
//
// WHY WE MEASURE PEAK IN-FLIGHT, NOT A POST-SETTLE HEAP DELTA
// ----------------------------------------------------------
// The leak is held from the BOTTOM (pending syscalls), not retained in the JS
// heap. Once a burst drains, the parked await-stacks are GC'd and FSReqPromise
// returns to ~0 on BOTH leaky and fixed code — so a "warmup snapshot → renders →
// settle → snapshot" delta is a FALSE GREEN. The only signal that distinguishes
// leaky from fixed is the PEAK number of concurrent in-flight fs ops while the
// burst is live. `async_hooks` observes exactly that (it tracks the same
// FSREQPROMISE resources libuv holds), deterministically and without depending
// on the not-yet-built concurrency gate.
//
// WHAT KEEPS THIS GREEN
// ---------------------
// gn4.2 landed the bound: a single-owner concurrency gate (src/utils/
// transcript-fs.ts) routes every transcript readdir/stat/read through one
// limiter, so peak in-flight is capped by a constant no matter how many renders
// fan out. Removing that gate (or routing fs around it) re-admits the unbounded
// fan-out and this assertion fails at thousands-in-flight — that is the
// regression this gate guards against. Do NOT weaken the ceiling to "fix" a
// failure; a failure here means the bound was lost, not that the bar is wrong.
// The "observes real transcript fs ops" test below is a non-failing safety net:
// it runs the same measurement path, so a broken harness (import error, no-op
// observer) surfaces as a loud red instead of making this gate vacuously green.

import { createHook } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findProjectPaths, foldAppended } from "../src/utils/claude";

// Synthetic transcript tree: K project dirs × J .jsonl files. Sized so one
// render alone fans out to hundreds of concurrent fs ops (K readdirs + J stats
// + J parses per project), and the bound child will cap that at a small
// constant. Disposable tmp — never touches ~/.claude.
const PROJECTS = 16;
const FILES_PER_PROJECT = 8;

// [LAW:dataflow-not-control-flow] The bounded fix introduces a single owner of
// the in-flight-fs budget; the strongest true theorem it restores is "peak
// concurrent transcript fs ops is bounded by a constant, regardless of render
// rate". UV_THREADPOOL_SIZE defaults to 4 and a sane gate caps dispatched-but-
// incomplete ops at ~16–32. 64 is generous headroom over that, yet far below
// the unbounded peak (render-concurrency × files × ops-per-file ≈ thousands),
// so it cleanly separates leaky from fixed.
const IN_FLIGHT_CEILING = 64;
const RENDER_CONCURRENCY = 8;

let root: string;
// [LAW:single-enforcer] Jest workers run files sequentially in one process;
// restore the env we borrow so the scan root can't leak into another file.
const savedEnv = {
  cache: process.env.XDG_CACHE_HOME,
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cc-candybar-mem-"));
  const projectsDir = join(root, "projects");
  for (let p = 0; p < PROJECTS; p++) {
    const dir = join(projectsDir, `proj-${p}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < FILES_PER_PROJECT; f++) {
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        requestId: `req-${p}-${f}`,
        message: {
          id: `msg-${p}-${f}`,
          model: "claude-opus-4-8",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      writeFileSync(join(dir, `sess-${f}.jsonl`), line + "\n");
    }
  }
  process.env.XDG_CACHE_HOME = join(root, "cache");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  restoreEnv("XDG_CACHE_HOME", savedEnv.cache);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// Observe libuv's pending fs-request table from outside the code under test.
// FSREQPROMISE is the async_hooks resource type for fs/promises operations —
// the same objects that appeared as "Node / FSReqPromise" in the OOM snapshot.
function makeFsObserver() {
  const live = new Set<number>();
  let peak = 0;
  const hook = createHook({
    init(id, type) {
      if (type === "FSREQPROMISE") {
        live.add(id);
        if (live.size > peak) peak = live.size;
      }
    },
    destroy(id) {
      live.delete(id);
    },
  });
  return { hook, peak: () => peak };
}

// Every transcript file of the synthetic tree.
const allFiles = (): string[] =>
  Array.from({ length: PROJECTS }, (_, p) =>
    Array.from({ length: FILES_PER_PROJECT }, (_, f) =>
      join(root, "projects", `proj-${p}`, `sess-${f}.jsonl`),
    ),
  ).flat();

// One burst: the project walk, and a cold fold of every transcript at once —
// the reader every fold goes through (brandon-unfiled-3248.bfnj). With the
// gate removed, `renderConcurrency` overlapping bursts put ~1024 reads in
// flight at once.
function burst(renderConcurrency: number): Promise<unknown> {
  return Promise.all(
    Array.from({ length: renderConcurrency }, () =>
      Promise.all([
        findProjectPaths([root]),
        ...allFiles().map((f) =>
          foldAppended(f, undefined, 0, (n, entries) => n + entries.length),
        ),
      ]),
    ),
  );
}

// Drive `renderConcurrency` overlapping bursts to completion and return the
// peak number of transcript fs ops in flight at any instant during them.
async function measurePeakInFlight(renderConcurrency: number): Promise<number> {
  const obs = makeFsObserver();
  obs.hook.enable();
  try {
    await burst(renderConcurrency);
  } finally {
    obs.hook.disable();
  }
  return obs.peak();
}

describe("daemon transcript-fs concurrency", () => {
  // [LAW:single-enforcer] PINNED REGRESSION GATE. Bounded by a documented
  // constant regardless of render rate. gn4.2 landed the single-owner gate
  // (src/utils/transcript-fs.ts) that routes every transcript readdir/stat/
  // read through one limiter, so peak in-flight is now bounded by its cap.
  test(
    "peak in-flight transcript fs ops stays under the ceiling",
    async () => {
      const peak = await measurePeakInFlight(RENDER_CONCURRENCY);
      expect(peak).toBeLessThanOrEqual(IN_FLIGHT_CEILING);
    },
  );

  // Non-failing safety net: proves the observer is live and the fan-out is real,
  // so the `.failing` gate above can never pass vacuously (e.g. via an import
  // error or a no-op observer). Asserts only an invariant true in BOTH phases.
  test("the harness observes real transcript fs ops", async () => {
    const peak = await measurePeakInFlight(RENDER_CONCURRENCY);
    expect(peak).toBeGreaterThan(0);
  });
});

// Exercises the committed triage tools end-to-end as shipped CLIs (not their
// internals — [LAW:behavior-not-structure]), against a snapshot taken WHILE an
// fs burst is in flight. Guards the scripts from bitrot and demonstrates the
// heap-snapshot delta gate (diff) + retainer trace the 5qh evidence was built
// from. Always-green: the snapshots are constructed to contain the signal.
// The burst is plain reads, not the daemon's transcript reader: the scripts
// read pending fs ops of any origin, and the daemon's reader is the bound the
// concurrency gate above holds, not these.
describe("heap-analysis scripts", () => {
  const scriptsDir = join(process.cwd(), "scripts");
  let before: string;
  let after: string;

  beforeAll(() => {
    before = join(root, "before.heapsnapshot");
    after = join(root, "after.heapsnapshot");
    // The snapshots come from a bare node process, not this Jest worker: a
    // heap snapshot's cost is the heap's size, and the worker's holds every
    // transpiled module of the suite, which makes two of them the slowest
    // thing in this file by far and a minute on a shared CI core. The child
    // holds only the burst, so the scripts read the same FSReqPromise signal
    // from a heap a fraction of the size. Snapshot, launch the burst, let the
    // fan-out dispatch for a couple of event-loop turns, then snapshot WHILE
    // ops are pending (the FSReqPromise are gone once it drains).
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { writeHeapSnapshot } from "node:v8";
        import { readFile } from "node:fs/promises";
        const [before, after, ...files] = process.argv.slice(1);
        writeHeapSnapshot(before);
        const inFlight = Promise.all(files.map((f) => readFile(f)));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        writeHeapSnapshot(after);
        await inFlight;
        `,
        before,
        after,
        ...allFiles(),
      ],
      { stdio: "inherit" },
    );
  });

  test("heap-analyze diff reports FSReqPromise growth between snapshots", () => {
    const out = execFileSync(
      process.execPath,
      [join(scriptsDir, "heap-analyze.mjs"), before, after, "--match", "FSReqPromise", "--json"],
      { encoding: "utf8" },
    );
    const { diff } = JSON.parse(out) as {
      diff: Array<{ label: string; deltaCount: number }>;
    };
    const grew = diff.find((r) => /FSReqPromise/.test(r.label) && r.deltaCount > 0);
    expect(grew).toBeDefined();
  });

  test("heap-retainers traces FSReqPromise to a GC root", () => {
    const out = execFileSync(
      process.execPath,
      [join(scriptsDir, "heap-retainers.mjs"), after, "FSReqPromise", "--limit", "3", "--json"],
      { encoding: "utf8" },
    );
    const { paths, totalTargets } = JSON.parse(out) as {
      paths: string[][];
      totalTargets: number;
    };
    expect(totalTargets).toBeGreaterThan(0);
    expect(paths.length).toBeGreaterThan(0);
    // Root-first: the path must originate at V8's synthetic GC root and end at
    // the matched class — i.e. an actual retaining chain, not a fragment.
    expect(paths[0]![0]).toMatch(/synthetic/);
    expect(paths[0]![paths[0]!.length - 1]).toMatch(/FSReqPromise/);
  });
});
