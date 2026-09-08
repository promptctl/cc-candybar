// [LAW:verifiable-goals] The leak is held from the bottom (pending syscalls), not
// retained in the JS heap, so a post-settle heap delta is a false green: only PEAK
// concurrent in-flight fs ops separates leaky from fixed. A failure here means the bound was lost.

// [LAW:no-ambient-temporal-coupling] jest.setTimeout is FILE-scoped, so it is stated
// here rather than inside the one describe whose heap-snapshot cost motivates it.
jest.setTimeout(180_000);

import { createHook } from "node:async_hooks";
import { writeHeapSnapshot } from "node:v8";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEntriesFromProjects, clearParseCache } from "../src/utils/claude";

// Synthetic transcript tree sized so one render fans out to hundreds of concurrent fs ops. Never touches ~/.claude.
const PROJECTS = 16;
const FILES_PER_PROJECT = 8;

// [LAW:dataflow-not-control-flow] 64 is generous headroom over a sane gate's ~16–32
// dispatched-but-incomplete ops, yet far below the unbounded peak of thousands.
const IN_FLIGHT_CEILING = 64;
const RENDER_CONCURRENCY = 8;

let root: string;
// [LAW:single-enforcer] Jest workers share one process; restore the env we borrow.
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

// FSREQPROMISE is the async_hooks resource type for fs/promises operations.
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
  // [LAW:single-enforcer] Pinned regression gate: peak in-flight is bounded by a constant regardless of render rate.
  test(
    "peak in-flight transcript fs ops stays under the ceiling",
    async () => {
      const peak = await measurePeakInFlight(RENDER_CONCURRENCY);
      expect(peak).toBeLessThanOrEqual(IN_FLIGHT_CEILING);
    },
  );

  // Non-failing safety net, so the gate above can never pass vacuously on a broken harness.
  test("the harness observes real transcript fs ops", async () => {
    const peak = await measurePeakInFlight(RENDER_CONCURRENCY);
    expect(peak).toBeGreaterThan(0);
  });
});

// [LAW:behavior-not-structure] Exercises the triage tools as shipped CLIs, not their internals. Always green by construction.
describe("heap-analysis scripts", () => {
  const scriptsDir = join(process.cwd(), "scripts");
  let before: string;
  let after: string;

  beforeAll(async () => {
    clearParseCache();
    before = join(root, "before.heapsnapshot");
    after = join(root, "after.heapsnapshot");
    writeHeapSnapshot(before);
    // Snapshot WHILE ops are pending — the FSReqPromise are gone once the burst drains.
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
    // Root-first: the path must originate at V8's synthetic GC root, not be a fragment.
    expect(paths[0]![0]).toMatch(/synthetic/);
    expect(paths[0]![paths[0]!.length - 1]).toMatch(/FSReqPromise/);
  });
});
