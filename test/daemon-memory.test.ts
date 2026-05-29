// [LAW:verifiable-goals] The daemon RSS leak (epic brandon-daemon-memory-leak-gn4)
// must have a deterministic, machine-verifiable reproduction BEFORE any fix —
// past attempts failed by speculating. This file encodes the success/failure
// shape and pins it so the leak cannot silently return.
//
// WHAT THE LEAK IS (verified via heap snapshots — see ticket 5qh)
// --------------------------------------------------------------
// The transcript-scanning provider path (`loadEntriesFromProjects`) fans out an
// UNBOUNDED `Promise.all` over every transcript file on every cache-miss render.
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
// RED → GREEN HANDSHAKE
// --------------------
// The bounded-concurrency gate lands in a LATER child (gn4.2). Until it does,
// the bound assertion below cannot hold, so it is pinned with `test.failing`:
// CI stays green while the known-broken invariant is documented. When gn4.2
// lands, this test starts PASSING, which makes `test.failing` FAIL — that red is
// the signal to flip `test.failing` → `test` (do NOT weaken the ceiling). The
// `it("observes the fan-out")` characterization below is a non-failing safety
// net: it runs the same measurement path, so a broken harness surfaces as a
// loud red here instead of silently making the `.failing` gate vacuously green.

import { createHook } from "node:async_hooks";
import { writeHeapSnapshot } from "node:v8";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEntriesFromProjects, clearParseCache } from "../src/utils/claude";

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
  config: process.env.CLAUDE_CONFIG_DIR,
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
  process.env.CLAUDE_CONFIG_DIR = root;
  process.env.XDG_CACHE_HOME = join(root, "cache");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  restoreEnv("CLAUDE_CONFIG_DIR", savedEnv.config);
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

// Drive `renderConcurrency` overlapping renders to completion and return the
// peak number of transcript fs ops in flight at any instant during the burst.
async function measurePeakInFlight(renderConcurrency: number): Promise<number> {
  clearParseCache();
  const obs = makeFsObserver();
  obs.hook.enable();
  try {
    await Promise.all(
      Array.from({ length: renderConcurrency }, () =>
        loadEntriesFromProjects(undefined, undefined, true),
      ),
    );
  } finally {
    obs.hook.disable();
  }
  return obs.peak();
}

describe("daemon transcript-fs concurrency", () => {
  // [LAW:single-enforcer] PINNED REGRESSION GATE. Bounded by a documented
  // constant regardless of render rate. Fails on current main (unbounded
  // fan-out → thousands in flight); `test.failing` keeps CI green and flips to
  // red — "flip me to test()" — the moment gn4.2's bound makes it pass.
  test.failing(
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
describe("heap-analysis scripts", () => {
  const scriptsDir = join(process.cwd(), "scripts");
  let before: string;
  let after: string;

  beforeAll(async () => {
    clearParseCache();
    before = join(root, "before.heapsnapshot");
    after = join(root, "after.heapsnapshot");
    writeHeapSnapshot(before);
    // Launch the burst, let the fan-out dispatch for a couple of event-loop
    // turns, then snapshot WHILE ops are pending (the FSReqPromise are gone
    // once it drains). Drain afterward so nothing bleeds into other tests.
    const burst = Promise.all(
      Array.from({ length: RENDER_CONCURRENCY }, () =>
        loadEntriesFromProjects(undefined, undefined, true),
      ),
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    writeHeapSnapshot(after);
    await burst;
  });

  test("heap-analyze diff reports FSReqPromise growth between snapshots", () => {
    const out = execFileSync(
      "node",
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
      "node",
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
