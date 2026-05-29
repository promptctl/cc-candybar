// [LAW:verifiable-goals] gn4.3 acceptance, made machine-verifiable:
//   1. K concurrent renders for the same key trigger exactly ONE underlying
//      scan, not K.
//   2. A render that exceeds the timeout does not increase steady-state pending
//      fs ops.
//
// WHY CUMULATIVE OPS, NOT PEAK
// ----------------------------
// gn4.2's gate (src/utils/transcript-fs.ts) bounds PEAK in-flight fs ops at a
// constant whether there is 1 scan or 50 — so peak is structurally blind to
// coalescing. The signal that distinguishes "1 scan" from "K scans" is the
// CUMULATIVE count of fs ops: one whole-tree scan inits ~N FSREQPROMISE; K
// uncoalesced scans init ~K·N. async_hooks counts those inits deterministically.
//
// METHODOLOGY (each claim has its own apples-to-apples baseline)
// --------------------------------------------------------------
// - CONTROL proves the observer detects fan-out: K concurrent calls to the
//   UNCOALESCED free function `loadEntriesFromProjects` cost ~K× a single call.
// - CONTRACT proves the fix: K concurrent `TodayProvider.getTodayInfo()` cost
//   ~1× a single cold call, because they coalesce behind one SingleFlight.
// Both measurements start cold (parse cache cleared + disk usage cache removed).

import { createHook } from "node:async_hooks";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sized so one scan fans out to many fs ops (so K× is unmistakable) yet stays
// fast. K renders fire concurrently against the same key.
const PROJECTS = 12;
const FILES_PER_PROJECT = 6;
const K = 8;

let root: string;
const savedEnv = {
  config: process.env.CLAUDE_CONFIG_DIR,
  cache: process.env.XDG_CACHE_HOME,
};

// Bound late: CacheManager freezes its cache dir from XDG_CACHE_HOME at import,
// so the modules must be imported AFTER the tmp env is set, or getTodayInfo
// would read/write the real ~/.cache. Dynamic import in beforeAll guarantees
// the static init sees the tmp dirs.
type ClaudeMod = typeof import("../src/utils/claude");
type TodayMod = typeof import("../src/segments/today");
let claude: ClaudeMod;
let Today: TodayMod;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cc-candybar-coalesce-"));
  const projectsDir = join(root, "projects");
  const todayIso = new Date().toISOString();
  for (let p = 0; p < PROJECTS; p++) {
    const dir = join(projectsDir, `proj-${p}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < FILES_PER_PROJECT; f++) {
      // costUSD present so the today path skips the pricing-service lookup —
      // keeps the measured ops purely transcript-scan ops.
      const line = JSON.stringify({
        timestamp: todayIso,
        requestId: `req-${p}-${f}`,
        costUSD: 0.01,
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

  claude = await import("../src/utils/claude");
  Today = await import("../src/segments/today");
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

// Reset to a fully cold state: in-memory parse cache cleared and the on-disk
// usage cache removed, so the next getTodayInfo cannot hit either and must scan.
function resetCold(): void {
  claude.clearParseCache();
  rmSync(join(root, "cache"), { recursive: true, force: true });
}

// Count cumulative FSREQPROMISE inits (the libuv fs-request resource) over the
// duration of `body`. This is the per-scan-vs-per-K-scans signal.
async function countFsOps(body: () => Promise<unknown>): Promise<number> {
  let total = 0;
  const hook = createHook({
    init(_id, type) {
      if (type === "FSREQPROMISE") total++;
    },
  });
  hook.enable();
  try {
    await body();
  } finally {
    hook.disable();
  }
  return total;
}

describe("transcript-fs work coalescing (gn4.3)", () => {
  // CONTROL: the uncoalesced free function fans out ~K× under K concurrency.
  // This validates that the observer actually sees per-scan fan-out, so the
  // CONTRACT test below cannot pass vacuously (e.g. if getTodayInfo did no I/O).
  test("uncoalesced scans scale ~K× with concurrency (observer sanity)", async () => {
    resetCold();
    const one = await countFsOps(() =>
      claude.loadEntriesFromProjects(undefined, undefined, true),
    );
    resetCold();
    const many = await countFsOps(() =>
      Promise.all(
        Array.from({ length: K }, () =>
          claude.loadEntriesFromProjects(undefined, undefined, true),
        ),
      ),
    );
    expect(one).toBeGreaterThan(0);
    // No coalescing on the free function → K concurrent calls cost ~K× the ops.
    // Half-K is generous headroom against scheduling/parse-cache jitter.
    expect(many).toBeGreaterThan(one * (K / 2));
  });

  // CONTRACT: K concurrent today renders share ONE scan. Cold single call sets
  // the one-scan baseline; K concurrent cold calls must stay near it, not K×.
  test("K concurrent getTodayInfo trigger one scan, not K", async () => {
    resetCold();
    const provider = new Today.TodayProvider();
    const oneScan = await countFsOps(() => provider.getTodayInfo());

    resetCold();
    const coalesced = new Today.TodayProvider();
    const kConcurrent = await countFsOps(() =>
      Promise.all(Array.from({ length: K }, () => coalesced.getTodayInfo())),
    );

    expect(oneScan).toBeGreaterThan(0);
    // One shared scan ⇒ K concurrent renders cost roughly one scan's ops, far
    // below the ~K× an uncoalesced path would incur. 2× absorbs the disk-cache
    // read/write timing skew between the two cold runs.
    expect(kConcurrent).toBeLessThan(oneScan * 2);
  });

  // ACCEPTANCE #2: a render that abandons its await (the daemon's 200ms timeout
  // fires) must not spawn extra scans. We race each of K concurrent renders
  // against a 1ms timeout so they all abandon, then drive one final await to
  // completion. Coalescing established synchronously at call time means all K+1
  // share the ONE in-flight scan — a timeout adds zero fs work.
  test("timed-out renders do not multiply pending fs ops", async () => {
    resetCold();
    const baselineProvider = new Today.TodayProvider();
    const oneScan = await countFsOps(() => baselineProvider.getTodayInfo());

    resetCold();
    const provider = new Today.TodayProvider();
    const total = await countFsOps(async () => {
      const raced = Array.from({ length: K }, () =>
        Promise.race([
          provider.getTodayInfo(),
          new Promise((resolve) => setTimeout(() => resolve(null), 1)),
        ]),
      );
      // The abandoned awaits don't cancel the shared scan; this final call
      // coalesces onto it (or hits the now-warm cache) and lets it drain.
      raced.push(provider.getTodayInfo());
      await Promise.all(raced);
    });

    // Despite K renders timing out, steady-state fs work is one scan's worth.
    expect(total).toBeLessThan(oneScan * 2);
  });
});
