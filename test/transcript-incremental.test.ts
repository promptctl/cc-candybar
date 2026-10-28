// [LAW:verifiable-goals] The incremental append-fold (brandon-daemon-perf-bb9):
// an active session's transcript grows every render, and the store must fold ONLY
// the appended bytes rather than re-parse the whole file. These tests pin two
// contracts: (1) the fold sees exactly the new complete lines since a cursor,
// one window at a time (brandon-unfiled-3248.bfnj), waiting on a partial
// trailing line and resetting on a rewrite; (2) the store's
// incremental fold is OBSERVATIONALLY EQUAL to a from-scratch read of the final
// file — the optimization changes cost, never output.

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  foldAppended,
  type Folded,
  type ParsedEntry,
} from "../src/utils/claude";
import {
  FOLD_WINDOW_BYTES,
  readAppended,
  statStamp,
  transcriptReads,
} from "../src/utils/transcript-fs";
import { SessionUsageStore } from "../src/daemon/cache/session-usage-store";
import type { ClaudeHookData } from "../src/utils/claude";
import { Holds } from "../src/utils/holds";
import { instantOf } from "../src/utils/instant";
import { todayInfo, todayNow } from "./helpers/today";
import { until } from "./helpers/until";

let seq = 0;
// One newline-terminated usage line. Unique tags keep every entry distinct.
function line(day: Date, cost: number, inTok = 10, outTok = 5): string {
  const tag = `e${seq++}`;
  return (
    JSON.stringify({
      timestamp: day.toISOString(),
      requestId: `req-${tag}`,
      costUSD: cost,
      message: {
        id: `msg-${tag}`,
        model: "claude-opus-4-8",
        usage: { input_tokens: inTok, output_tokens: outTok },
      },
    }) + "\n"
  );
}

function hook(sessionId: string, transcriptPath: string): ClaudeHookData {
  return {
    session_id: sessionId,
    transcript_path: transcriptPath,
  } as ClaudeHookData;
}

// Advance mtime a step so the store's sync mtime gate registers a change — a real
// append across render ticks always moves the clock; tests are too fast to rely on
// wall-clock granularity.
let clock = Math.floor(Date.now() / 1000);
function touch(path: string): void {
  clock += 1;
  utimesSync(path, clock, clock);
}

// The step these tests fold with: every entry, in order. Whatever a real step
// computes, it computes over this sequence, so a fold that sees each line once
// and in order folds every step alike.
const collect = (
  state: readonly ParsedEntry[],
  entries: readonly ParsedEntry[],
): readonly ParsedEntry[] => [...state, ...entries];
const NONE: readonly ParsedEntry[] = [];

async function foldOf(
  path: string,
  prior?: Folded<readonly ParsedEntry[]>,
  step = collect,
) {
  const r = await foldAppended(path, prior, NONE, step);
  if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);
  return r.value;
}

const costs = (entries: readonly ParsedEntry[]) =>
  entries.map((e) => Number(e.costUSD!.toFixed(5)));

// One usage line padded to about `bytes`, so a file spans a known number of
// windows.
function paddedLine(cost: number, bytes: number): string {
  const base = JSON.parse(line(new Date(), cost)) as Record<string, unknown>;
  const pad = "x".repeat(Math.max(0, bytes - JSON.stringify(base).length - 10));
  return JSON.stringify({ ...base, pad }) + "\n";
}

describe("foldAppended — the windowed fold", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-candybar-inc-"));
    seq = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a first fold sees every complete line; a later one ONLY the appended ones", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(t, line(new Date(), 0.01) + line(new Date(), 0.02));

    const first = await foldOf(t);
    expect(costs(first.folded.value)).toEqual([0.01, 0.02]);

    appendFileSync(t, line(new Date(), 0.03));
    const second = await foldOf(t, first.folded, (_s, entries) => entries);
    // Only the one appended entry — not a re-read of the first two.
    expect(costs(second.folded.value)).toEqual([0.03]);
  });

  // brandon-unfiled-3248.bfnj: a cold fold of a large transcript holds one
  // window, not the file, and sees exactly the lines a whole-file read would.
  test("a file of several windows folds window by window to every line, in order", async () => {
    const t = join(dir, "big.jsonl");
    const lines = Array.from({ length: 5500 }, (_, i) =>
      paddedLine(i / 1000, 1024),
    );
    writeFileSync(t, lines.join(""));
    const bytes = Buffer.byteLength(lines.join(""));
    const before = transcriptReads();

    const { folded, longLines } = await foldOf(t);

    expect(costs(folded.value)).toEqual(lines.map((_, i) => i / 1000));
    expect(folded.cursor.offset).toBe(bytes);
    expect(longLines).toEqual([]);
    // One gated read per window, each consuming all but a partial line of
    // it, and none past the end.
    const reads = transcriptReads().reads - before.reads;
    expect(reads).toBeGreaterThanOrEqual(Math.ceil(bytes / FOLD_WINDOW_BYTES));
    expect(reads).toBeLessThanOrEqual(Math.ceil(bytes / (FOLD_WINDOW_BYTES - 1024)));
    expect(transcriptReads().longLines).toBe(before.longLines);
  });

  test("a line longer than the window is folded whole, and reported as a long line", async () => {
    const t = join(dir, "long.jsonl");
    const first = line(new Date(), 0.01);
    const long = paddedLine(0.02, Math.floor(FOLD_WINDOW_BYTES * 2.5));
    writeFileSync(t, first + long + line(new Date(), 0.03));
    const before = transcriptReads();

    const { folded, longLines } = await foldOf(t);

    expect(costs(folded.value)).toEqual([0.01, 0.02, 0.03]);
    expect(longLines).toEqual([
      { path: t, offset: Buffer.byteLength(first), bytes: Buffer.byteLength(long) },
    ]);
    expect(transcriptReads().longLines - before.longLines).toBe(1);
    expect(transcriptReads().largestLine).toBeGreaterThanOrEqual(
      Buffer.byteLength(long),
    );
  });

  test("a long line still being written allocates nothing and reports no long line", async () => {
    const t = join(dir, "writing.jsonl");
    const complete = line(new Date(), 0.01);
    writeFileSync(t, complete + "{" + "x".repeat(FOLD_WINDOW_BYTES * 3));
    const before = transcriptReads();

    const { folded, longLines } = await foldOf(t);

    expect(costs(folded.value)).toEqual([0.01]);
    expect(folded.cursor.offset).toBe(Buffer.byteLength(complete));
    expect(longLines).toEqual([]);
    expect(transcriptReads().longLines).toBe(before.longLines);
  });

  test("a partial trailing line (no newline yet) waits for its newline, and the fold returns", async () => {
    const t = join(dir, "A.jsonl");
    const complete = line(new Date(), 0.01);
    const partial = '{"timestamp":"2024-01-01T00:00:00.000Z","costUSD":0.02';
    writeFileSync(t, complete + partial);
    const before = transcriptReads();

    const first = await foldOf(t);
    expect(costs(first.folded.value)).toEqual([0.01]);
    expect(first.folded.cursor.offset).toBe(Buffer.byteLength(complete));
    // One read: the window that reached the end leaves nothing to re-read.
    expect(transcriptReads().reads - before.reads).toBe(1);

    appendFileSync(t, ',"message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n');
    const second = await foldOf(t, first.folded, (_s, entries) => entries);
    expect(costs(second.folded.value)).toEqual([0.02]);
  });

  test("a rewritten (shrunk) file starts the fold over from the start", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(t, line(new Date(), 0.01) + line(new Date(), 0.02) + line(new Date(), 0.03));
    const first = await foldOf(t);

    const compacted = line(new Date(), 0.09);
    writeFileSync(t, compacted);
    const after = await foldOf(t, first.folded);
    expect(costs(after.folded.value)).toEqual([0.09]);
    expect(after.folded.cursor.offset).toBe(Buffer.byteLength(compacted));
  });

  test("an inode change (rename-based rewrite) starts over even when size >= cursor", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(t, line(new Date(), 0.01) + line(new Date(), 0.02));
    const first = await foldOf(t);

    const other = join(dir, "A.new.jsonl");
    const rewritten =
      line(new Date(), 0.03) + line(new Date(), 0.04) + line(new Date(), 0.05);
    writeFileSync(other, rewritten);
    expect(Buffer.byteLength(rewritten)).toBeGreaterThanOrEqual(
      first.folded.cursor.offset,
    );
    renameSync(other, t);

    const after = await foldOf(t, first.folded);
    expect(costs(after.folded.value)).toEqual([0.03, 0.04, 0.05]);
  });

  test("a rewrite between two windows starts the fold over from empty", async () => {
    const t = join(dir, "mid.jsonl");
    // Led by a long line, so the discarded pass read one.
    writeFileSync(
      t,
      paddedLine(0.01, Math.floor(FOLD_WINDOW_BYTES * 1.5)) +
        Array.from({ length: 2200 }, (_, i) => paddedLine(i / 1000, 1024)).join(""),
    );
    const replaced = line(new Date(), 0.5) + line(new Date(), 0.6);
    let windows = 0;
    // The first window's step swaps the file under the path, as a rename-based
    // /compact would land mid-fold.
    const { folded, longLines } = await foldOf(t, undefined, (state, entries) => {
      if (windows++ === 0) {
        writeFileSync(join(dir, "mid.new.jsonl"), replaced);
        renameSync(join(dir, "mid.new.jsonl"), t);
      }
      return collect(state, entries);
    });

    expect(costs(folded.value)).toEqual([0.5, 0.6]);
    expect(folded.cursor.offset).toBe(Buffer.byteLength(replaced));
    // The long line belonged to the file the reset discarded.
    expect(longLines).toEqual([]);
  });

  test("a read disposed twice gives its window back once", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(t, line(new Date(), 0.01));
    const read = await readAppended(t, undefined, undefined);
    if (read.kind !== "ok") throw new Error("expected ok");
    read.value[Symbol.dispose]();
    read.value[Symbol.dispose]();

    // Two reads in flight at once never share a window.
    const [a, b] = await Promise.all([
      readAppended(t, undefined, undefined),
      readAppended(t, undefined, undefined),
    ]);
    if (a.kind !== "ok" || b.kind !== "ok") throw new Error("expected ok");
    expect(a.value.lines.buffer).not.toBe(b.value.lines.buffer);
    a.value[Symbol.dispose]();
    b.value[Symbol.dispose]();
  });

  // Every read of a fold is capped at the size its first stat saw, so a file
  // growing faster than it is read cannot hold it, and the cursor's stamp
  // names exactly the bytes folded. The next fold reads on from the cursor:
  // every line is folded once, none twice.
  test("growth during a fold ends it, with the first stat's stamp, and the next fold reads on", async () => {
    const t = join(dir, "grow.jsonl");
    const lines = Array.from({ length: 2200 }, (_, i) => paddedLine(i / 1000, 1024));
    writeFileSync(t, lines.join(""));
    const firstStamp = statStamp(t);
    let windows = 0;
    const { folded } = await foldOf(t, undefined, (state, entries) => {
      if (windows++ < 6) appendFileSync(t, line(new Date(), 9));
      return collect(state, entries);
    });

    expect(folded.cursor.stamp).toBe(firstStamp);
    expect(folded.cursor.offset).toBe(Buffer.byteLength(lines.join("")));
    expect(costs(folded.value)).toEqual(lines.map((_, i) => i / 1000));
    const next = await foldOf(t, folded, (_s, entries) => entries);
    expect(costs(next.folded.value)).toEqual(
      Array.from({ length: Math.min(windows, 6) }, () => 9),
    );
  });

  test("absent file (fresh session) is the absent outcome, not an error", async () => {
    const res = await foldAppended(join(dir, "missing.jsonl"), undefined, NONE, collect);
    expect(res.kind).toBe("absent");
  });

  test("an unreadable path is failed, with its reason", async () => {
    const res = await foldAppended(dir, undefined, NONE, collect);
    expect(res.kind).toBe("failed");
  });

  test("a prior cursor on an unchanged file folds nothing new", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(t, line(new Date(), 0.01) + line(new Date(), 0.02));
    const first = await foldOf(t);
    const again = await foldOf(t, first.folded, (_s, entries) => entries);
    expect(again.folded.value).toEqual([]);
    expect(again.folded.cursor.offset).toBe(first.folded.cursor.offset);
  });
});

describe("SessionUsageStore — incremental fold equals from-scratch", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-candybar-inc-store-"));
    seq = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("folding appends incrementally yields the same totals as one whole-file read", async () => {
    const today = new Date();
    const contents = [
      line(today, 0.01, 100, 20),
      line(today, 0.02, 200, 40),
      line(today, 0.03, 300, 60),
      line(today, 0.04, 400, 80),
    ];

    // Incremental: append one line per "render", ingesting between each.
    const incPath = join(dir, "inc.jsonl");
    writeFileSync(incPath, "");
    const incStore = new SessionUsageStore({ sweepIntervalMs: 0 });
    let incInfo;
    try {
      for (const c of contents) {
        appendFileSync(incPath, c);
        touch(incPath);
        incInfo = await incStore.getUsageInfo("INC", hook("INC", incPath));
      }
    } finally {
      incStore.close();
    }

    // From-scratch: the same final file read once by a cold store.
    const fullPath = join(dir, "full.jsonl");
    writeFileSync(fullPath, contents.join(""));
    const freshStore = new SessionUsageStore({ sweepIntervalMs: 0 });
    let freshInfo;
    try {
      freshInfo = await freshStore.getUsageInfo("FULL", hook("FULL", fullPath));
    } finally {
      freshStore.close();
    }

    expect(incInfo?.kind).toBe("ok");
    expect(freshInfo?.kind).toBe("ok");
    if (incInfo?.kind !== "ok" || freshInfo?.kind !== "ok") return;
    // The whole point: incremental output == from-scratch output.
    expect(incInfo.value.session.cost).toBeCloseTo(
      freshInfo.value.session.cost!,
      5,
    );
    expect(incInfo.value.session.tokens).toBe(freshInfo.value.session.tokens);
    expect(incInfo.value.session.cost).toBeCloseTo(0.1, 5);
    expect(incInfo.value.session.tokens).toBe(1000 + 200); // inputs + outputs
  });

  test("concurrent different-stamp refolds do not double-count (the first to land wins)", async () => {
    // Two renders observing DIFFERENT stamps hit different SingleFlight keys
    // and both read the same prior. The commit is a compare-and-set on that
    // prior, so whichever lands first is stored and the other is not; and
    // `refold` writes the byte cursor and the fold as one pair covering exactly
    // [0, cursor), so the next ingest extends from there. This test pins the
    // OBSERVABLE consequence — no matter which racer lands, a final read equals
    // a from-scratch read of the same file (a double-count would exceed it).
    const t = join(dir, "R.jsonl");
    const l1 = line(new Date(), 0.01, 100, 20);
    const l2 = line(new Date(), 0.02, 200, 40);
    const l3 = line(new Date(), 0.03, 300, 60);

    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      // Prior established.
      writeFileSync(t, l1);
      touch(t);
      await store.getUsageInfo("R", hook("R", t));

      // Grow to mtime M1, fire A (sees M1) WITHOUT awaiting.
      appendFileSync(t, l2);
      touch(t);
      const a = store.getUsageInfo("R", hook("R", t));
      // Grow again to mtime M2, fire B (sees M2) WITHOUT awaiting → different
      // flight keys, both racing off the same prior.
      appendFileSync(t, l3);
      touch(t);
      const b = store.getUsageInfo("R", hook("R", t));
      await Promise.all([a, b]);

      // A settling read must reflect the whole file regardless of who won.
      const finalInfo = await store.getUsageInfo("R", hook("R", t));
      if (finalInfo.kind !== "ok") throw new Error("expected ok");

      const fullPath = join(dir, "Rfull.jsonl");
      writeFileSync(fullPath, l1 + l2 + l3);
      const fresh = new SessionUsageStore({ sweepIntervalMs: 0 });
      try {
        const freshInfo = await fresh.getUsageInfo("Rf", hook("Rf", fullPath));
        if (freshInfo.kind !== "ok") throw new Error("expected ok");
        expect(finalInfo.value.session.cost).toBeCloseTo(
          freshInfo.value.session.cost!,
          5,
        );
        expect(finalInfo.value.session.tokens).toBe(
          freshInfo.value.session.tokens,
        );
        // And concretely: 0.06 total, 660 input+output tokens — folded once.
        expect(finalInfo.value.session.cost).toBeCloseTo(0.06, 5);
      } finally {
        fresh.close();
      }
    } finally {
      store.close();
    }
  });

  // [LAW:no-ambient-temporal-coupling] An older fold landing first (a
  // rescan's, say) must not cost the newer one its store: the bar draws the
  // stored record, so a dropped newer fold would show the older totals until
  // the session's next request.
  test("a newer fold that lands after an older one is still the one stored", async () => {
    const t = join(dir, "N.jsonl");
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    // Hold each of the first two folds until released, so the older lands first.
    const internals = store as unknown as {
      refold: (...args: unknown[]) => Promise<unknown>;
    };
    const refold = internals.refold.bind(store);
    const held: Array<() => void> = [];
    internals.refold = async (...args) => {
      const out = await refold(...args);
      if (held.length < 2) await new Promise<void>((r) => held.push(r));
      return out;
    };
    const heldCount = (n: number) =>
      until(() => held.length >= n, `${n} held folds`);
    try {
      writeFileSync(t, line(new Date(), 0.01, 100, 20));
      touch(t);
      const older = store.getUsageInfo("N", hook("N", t));
      await heldCount(1);
      appendFileSync(t, line(new Date(), 0.02, 200, 40));
      touch(t);
      const newer = store.getUsageInfo("N", hook("N", t));
      await heldCount(2);
      held[0]!();
      await older;
      held[1]!();
      await newer;

      const stored = store.usageOf("N", hook("N", t));
      expect(stored).toMatchObject({
        kind: "ok",
        value: { session: { cost: expect.closeTo(0.03, 5), tokens: 360 } },
      });
    } finally {
      store.close();
    }
  });

  test("combines main + agent transcripts and a warm re-read does not double-count", async () => {
    const sid = "S";
    const mainPath = join(dir, `${sid}.jsonl`);
    writeFileSync(mainPath, line(new Date(), 0.01));
    // Agent sidechain discovered at <dir>/<sid>/subagents/agent-*.jsonl whose
    // first line's sessionId matches.
    const subagents = join(dir, sid, "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(subagents, "agent-1.jsonl"),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId: sid,
        requestId: "req-agent",
        costUSD: 0.02,
        message: {
          id: "msg-agent",
          model: "claude-opus-4-8",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }) + "\n",
    );

    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const first = await store.getUsageInfo(sid, hook(sid, mainPath));
      if (first.kind !== "ok") throw new Error("expected ok");
      expect(first.value.session.cost).toBeCloseTo(0.03, 5);

      // A warm re-read (mtime unchanged) must return the same total — the old
      // push-into-shared-array bug double-counted agents here.
      const second = await store.getUsageInfo(sid, hook(sid, mainPath));
      if (second.kind !== "ok") throw new Error("expected ok");
      expect(second.value.session.cost).toBeCloseTo(0.03, 5);
    } finally {
      store.close();
    }
  });

  test("day cost includes the PRICED value for entries lacking costUSD (matches session cost)", async () => {
    // Regression guard: the old path mutated costUSD to the priced value before
    // bucketing, so an un-costed entry contributed its priced cost to `today`.
    // foldFile must do the same — session and day cost agree for such entries.
    // Isolate the seed to an empty Claude Code directory so `today` folds only
    // the active session.
    const cfgRoot = mkdtempSync(join(tmpdir(), "cc-candybar-inc-cfg-"));
    try {
      const t = join(dir, "P.jsonl");
      // No costUSD → priced by the unknown-model fallback (input $3/M, output
      // $15/M): 1M input + 1M output ⇒ $3 + $15 = $18.
      writeFileSync(
        t,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          requestId: "req-p",
          model: "claude-test-model",
          message: {
            id: "msg-p",
            model: "claude-test-model",
            usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
          },
        }) + "\n",
      );
      const store = new SessionUsageStore({ sweepIntervalMs: 0 });
      try {
        const usage = await store.getUsageInfo("P", hook("P", t));
        const today = await todayInfo(store, 
          new Holds(),
          hook("P", t),
          cfgRoot,
          instantOf(new Date()),
        );
        if (usage.kind !== "ok" || today.kind !== "ok")
          throw new Error("expected ok");
        expect(usage.value.session.cost).toBeCloseTo(18, 5);
        // The regression this pins: today MUST equal the session's priced cost,
        // not 0 (which the pre-fix `costUSD ?? 0` day bucket produced).
        expect(today.value.cost).toBeCloseTo(18, 5);
      } finally {
        store.close();
      }
    } finally {
      rmSync(cfgRoot, { recursive: true, force: true });
    }
  });

  test("a compacted (rewritten smaller) transcript re-folds to the new file's totals", async () => {
    const t = join(dir, "C.jsonl");
    writeFileSync(t, line(new Date(), 0.01) + line(new Date(), 0.02) + line(new Date(), 0.03));
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const before = await store.getUsageInfo("C", hook("C", t));
      if (before.kind !== "ok") throw new Error("expected ok");
      expect(before.value.session.cost).toBeCloseTo(0.06, 5);

      // /compact: fewer, different entries; file shrinks below the cursor.
      writeFileSync(t, line(new Date(), 0.005));
      touch(t);
      const after = await store.getUsageInfo("C", hook("C", t));
      if (after.kind !== "ok") throw new Error("expected ok");
      expect(after.value.session.cost).toBeCloseTo(0.005, 5);
    } finally {
      store.close();
    }
  });
});
