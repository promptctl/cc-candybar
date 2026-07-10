// [LAW:verifiable-goals] The incremental append-fold (brandon-daemon-perf-bb9):
// an active session's transcript grows every render, and the store must fold ONLY
// the appended bytes rather than re-parse the whole file. These tests pin two
// contracts: (1) the reader yields exactly the new complete lines since a cursor,
// waiting on a partial trailing line and resetting on a rewrite; (2) the store's
// incremental fold is OBSERVATIONALLY EQUAL to a from-scratch read of the final
// file — the optimization changes cost, never output.

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readAppendedEntries,
  clearParseCache,
  type TranscriptCursor,
} from "../src/utils/claude";
import { SessionUsageStore } from "../src/daemon/cache/session-usage-store";
import type { ClaudeHookData } from "../src/utils/claude";

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

describe("readAppendedEntries — the incremental reader primitive", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-candybar-inc-"));
    seq = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("first read yields all complete lines; a later read yields ONLY the appended ones", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(t, line(new Date(), 0.01) + line(new Date(), 0.02));

    const first = await readAppendedEntries(t, undefined);
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    expect(first.value.entries).toHaveLength(2);
    expect(first.value.reset).toBe(false);

    appendFileSync(t, line(new Date(), 0.03));
    const second = await readAppendedEntries(t, first.value.cursor);
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    // Only the one appended entry — not a re-read of the first two.
    expect(second.value.entries).toHaveLength(1);
    expect(second.value.entries[0]!.costUSD).toBeCloseTo(0.03, 5);
  });

  test("a partial trailing line (no newline yet) is NOT consumed until its newline lands", async () => {
    const t = join(dir, "A.jsonl");
    const complete = line(new Date(), 0.01);
    // Write one complete line + a half-written second line (no \n).
    const partial = '{"timestamp":"2024-01-01T00:00:00.000Z","costUSD":0.02';
    writeFileSync(t, complete + partial);

    const first = await readAppendedEntries(t, undefined);
    if (first.kind !== "ok") throw new Error("expected ok");
    expect(first.value.entries).toHaveLength(1); // partial line waits
    const afterComplete = first.value.cursor.offset;
    expect(afterComplete).toBe(Buffer.byteLength(complete)); // cursor at the newline

    // The writer finishes the second line.
    appendFileSync(t, ',"message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n');
    const second = await readAppendedEntries(t, first.value.cursor);
    if (second.kind !== "ok") throw new Error("expected ok");
    expect(second.value.entries).toHaveLength(1); // the now-complete line, once
    expect(second.value.entries[0]!.costUSD).toBeCloseTo(0.02, 5);
  });

  test("a rewritten (shrunk) file signals reset and re-reads from the start", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(t, line(new Date(), 0.01) + line(new Date(), 0.02) + line(new Date(), 0.03));
    const first = await readAppendedEntries(t, undefined);
    if (first.kind !== "ok") throw new Error("expected ok");
    expect(first.value.entries).toHaveLength(3);

    // /compact rewrites the transcript smaller than our cursor.
    writeFileSync(t, line(new Date(), 0.09));
    const after = await readAppendedEntries(t, first.value.cursor);
    if (after.kind !== "ok") throw new Error("expected ok");
    expect(after.value.reset).toBe(true);
    expect(after.value.entries).toHaveLength(1); // the whole new file
    expect(after.value.cursor.offset).toBe(Buffer.byteLength(line(new Date(), 0.09)));
  });

  test("absent file (fresh session) is the absent outcome, not an error", async () => {
    const res = await readAppendedEntries(join(dir, "missing.jsonl"), undefined);
    expect(res.kind).toBe("absent");
  });
});

describe("SessionUsageStore — incremental fold equals from-scratch", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-candybar-inc-store-"));
    clearParseCache();
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
