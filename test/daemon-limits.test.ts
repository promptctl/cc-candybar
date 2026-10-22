import {
  makeLimits,
  type LimitsDeps,
  DEFAULT_RSS_LIMIT_MB,
  HEAP_CAP_OVER_RSS,
  RSS_LIMIT_ENV,
  memoryLimitMb,
  heapCapMb,
  postMortemsOf,
  realLimitsDeps,
  STAND_IN_AFTER_UNREAD,
} from "../src/daemon/limits";
import type { MemoryCharge } from "../src/daemon/memory-report";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Recorder {
  shutdownCalls: number[];
  snapshotsWritten: string[];
  reportsWritten: Array<{ file: string; text: string }>;
  // Every artifact step in the order it happened — the ordering claim below is
  // about which state the memory attribution describes, so it has to be
  // observable, not inferred.
  order: string[];
  captureThrows: boolean;
  reportWriteThrows: boolean;
  removed: string[];
  logs: Array<{ level: string; msg: string }>;
  fakeRss: number;
  // What the platform charges; absent, RSS is the charge (Linux).
  fakeCharge?: MemoryCharge;
  fakeHeapTotal: number;
  fakeNow: number;
  startedAtMs: number;
  pid: number;
  snapshotDir: string;
  existingFiles: string[];
}

function makeDeps(rec: Recorder, overrides: Partial<LimitsDeps> = {}): LimitsDeps {
  return {
    now: () => rec.fakeNow,
    pid: rec.pid,
    snapshotDir: rec.snapshotDir,
    log: (level, msg) => rec.logs.push({ level, msg }),
    memoryBytes: () => ({ rss: rec.fakeRss, heapTotal: rec.fakeHeapTotal }),
    memoryCharge: async (rss) =>
      rec.fakeCharge ?? { kind: "charged", measure: "rss", bytes: rss },
    captureMemoryReport: () => {
      rec.order.push("capture");
      if (rec.captureThrows) throw new Error("footprint exploded");
      return "# memory report from: footprint -p 4242\n118 MB tag 16";
    },
    writeMemoryReport: (file, text) => {
      rec.order.push("write-report");
      if (rec.reportWriteThrows) throw new Error("EACCES");
      rec.reportsWritten.push({ file, text });
      rec.existingFiles.push(file);
    },
    writeHeapSnapshot: (file) => {
      rec.order.push("write-heap");
      rec.snapshotsWritten.push(file);
      rec.existingFiles.push(file);
      return file;
    },
    listArtifacts: () => [...rec.existingFiles],
    removeFile: (file) => {
      rec.removed.push(file);
      const i = rec.existingFiles.indexOf(file);
      if (i >= 0) rec.existingFiles.splice(i, 1);
    },
    shutdown: (code) => rec.shutdownCalls.push(code),
    startedAtMs: rec.startedAtMs,
    ...overrides,
  };
}

function newRec(): Recorder {
  return {
    shutdownCalls: [],
    snapshotsWritten: [],
    removed: [],
    logs: [],
    reportsWritten: [],
    order: [],
    captureThrows: false,
    reportWriteThrows: false,
    fakeRss: 50 * 1024 * 1024,
    fakeHeapTotal: 20 * 1024 * 1024,
    fakeNow: Date.parse("2026-04-01T00:00:00Z"),
    startedAtMs: Date.parse("2026-04-01T00:00:00Z"),
    pid: 4242,
    snapshotDir: "/fake-snapshot-dir",
    existingFiles: [],
  };
}

describe("limits.check", () => {
  test("under limit: no shutdown, no snapshot", async () => {
    const rec = newRec();
    const limits = makeLimits(makeDeps(rec));
    expect(await limits.check()).toBe(false);
    expect(rec.shutdownCalls).toEqual([]);
    expect(rec.snapshotsWritten).toEqual([]);
  });

  test("over limit: writes snapshot then shuts down", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * 1024 * 1024;
    const limits = makeLimits(makeDeps(rec, { limitBytes: 200 * 1024 * 1024 }));
    expect(await limits.check()).toBe(true);
    expect(rec.snapshotsWritten).toHaveLength(1);
    expect(rec.shutdownCalls).toEqual([0]);
  });

  test("only triggers once even if RSS stays high", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * 1024 * 1024;
    const limits = makeLimits(makeDeps(rec, { limitBytes: 200 * 1024 * 1024 }));
    await limits.check();
    await limits.check();
    await limits.check();
    expect(rec.shutdownCalls).toEqual([0]);
    expect(rec.snapshotsWritten).toHaveLength(1);
  });

  test("callers overlapping one slow reading share it, so a breach is recorded once", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * 1024 * 1024;
    let answer: (c: MemoryCharge) => void = () => {};
    let probes = 0;
    const limits = makeLimits(
      makeDeps(rec, {
        limitBytes: 200 * 1024 * 1024,
        memoryCharge: () => {
          probes++;
          return new Promise((resolve) => (answer = resolve));
        },
      }),
    );
    const both = Promise.all([limits.check(), limits.check()]);
    answer({ kind: "charged", measure: "phys_footprint", bytes: rec.fakeRss });
    expect(await both).toEqual([true, true]);
    expect(probes).toBe(1);
    expect(rec.shutdownCalls).toEqual([0]);
    expect(rec.snapshotsWritten).toHaveLength(1);
    expect(rec.reportsWritten).toHaveLength(1);
  });

  test("snapshot filename is written under the injected dir, not the real daemonDir", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * 1024 * 1024;
    const limits = makeLimits(makeDeps(rec, { limitBytes: 200 * 1024 * 1024 }));
    await limits.check();
    expect(rec.snapshotsWritten[0]).toMatch(
      /^\/fake-snapshot-dir\/heap-.*\.heapsnapshot$/,
    );
    // No ambient logging: every line landed in the injected sink.
    expect(rec.logs.map((l) => l.msg)).toContain(
      "heap snapshot written: /fake-snapshot-dir/heap-2026-04-01T00-00-00-000Z-4242.heapsnapshot",
    );
  });

  test("filename carries the pid so overlapping daemons never collide", async () => {
    // Two daemons hit the wall at the SAME instant (identical fakeNow); only
    // the pid distinguishes their snapshots, so neither clobbers the other.
    const a = newRec();
    a.fakeRss = 250 * 1024 * 1024;
    a.pid = 111;
    await makeLimits(makeDeps(a, { limitBytes: 200 * 1024 * 1024 })).check();

    const b = newRec();
    b.fakeRss = 250 * 1024 * 1024;
    b.pid = 222;
    await makeLimits(makeDeps(b, { limitBytes: 200 * 1024 * 1024 })).check();

    expect(a.snapshotsWritten[0]).toContain("-111.heapsnapshot");
    expect(b.snapshotsWritten[0]).toContain("-222.heapsnapshot");
    expect(a.snapshotsWritten[0]).not.toBe(b.snapshotsWritten[0]);
  });
});


// brandon-daemon-limits-inw. A heap snapshot can only ever describe the V8 half,
// and the breach that trips this backstop is the one where RSS and the heap
// disagree — measured on the live daemon as 230 MB RSS against a 122 MB heap. So
// the death path also records what the platform can attribute.
describe("the breach records where the memory actually was", () => {
  async function breach(rec: Recorder): Promise<void> {
    rec.fakeRss = 250 * 1024 * 1024;
    await makeLimits(makeDeps(rec, { limitBytes: 200 * 1024 * 1024 })).check();
  }

  test("the captured attribution is written beside the snapshot, same identity", async () => {
    const rec = newRec();
    await breach(rec);
    expect(rec.reportsWritten).toHaveLength(1);
    expect(rec.reportsWritten[0]!.file).toBe(
      "/fake-snapshot-dir/memory-2026-04-01T00-00-00-000Z-4242.txt",
    );
    // The captured text reaches the file verbatim — the capture and the write
    // are separate deps precisely so this is observable.
    expect(rec.reportsWritten[0]!.text).toContain("118 MB tag 16");
    // Same stamp and pid as the snapshot: one breach, one identity, two files.
    expect(rec.snapshotsWritten[0]).toBe(
      "/fake-snapshot-dir/heap-2026-04-01T00-00-00-000Z-4242.heapsnapshot",
    );
  });

  // [LAW:no-ambient-temporal-coupling] Ordering that matters is stated, not
  // hoped for: writing a heap snapshot allocates and can move hundreds of MB, so
  // an attribution taken afterwards would describe the state the SNAPSHOT
  // produced rather than the state that tripped the limit.
  test("the attribution is captured before the snapshot rewrites the state", async () => {
    const rec = newRec();
    await breach(rec);
    expect(rec.order).toEqual(["capture", "write-report", "write-heap"]);
  });

  // [LAW:no-silent-failure] One artifact failing must not cost the other: they
  // are separately attempted, and each failure is named in the log.
  test("a failed capture still leaves the heap snapshot and a reason", async () => {
    const rec = newRec();
    rec.captureThrows = true;
    await breach(rec);
    expect(rec.snapshotsWritten).toHaveLength(1);
    expect(rec.reportsWritten).toHaveLength(0);
    expect(rec.logs.map((l) => `${l.level}: ${l.msg}`).join("\n")).toContain(
      "footprint exploded",
    );
    expect(rec.shutdownCalls).toEqual([0]);
  });

  test("a failed report write still leaves the heap snapshot and a reason", async () => {
    const rec = newRec();
    rec.reportWriteThrows = true;
    await breach(rec);
    expect(rec.snapshotsWritten).toHaveLength(1);
    expect(rec.logs.map((l) => l.msg).join("\n")).toContain("EACCES");
    expect(rec.shutdownCalls).toEqual([0]);
  });

  test("the breach log names the heap share of the charge that tripped it", async () => {
    const rec = newRec();
    rec.fakeHeapTotal = 30 * 1024 * 1024;
    await breach(rec);
    const warn = rec.logs.find((l) => l.level === "warn")!.msg;
    expect(warn).toContain("rss 250 MB > limit 200 MB");
    expect(warn).toContain("v8 heap 30 MB");
  });
});

describe("heap snapshot rotation", () => {
  test("keeps only the 3 newest snapshots", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * 1024 * 1024;
    rec.existingFiles = [
      "/d/heap-2026-01-01T00-00-00-000Z-1.heapsnapshot",
      "/d/heap-2026-02-01T00-00-00-000Z-1.heapsnapshot",
      "/d/heap-2026-03-01T00-00-00-000Z-1.heapsnapshot",
    ];
    const limits = makeLimits(makeDeps(rec, { limitBytes: 200 * 1024 * 1024 }));
    await limits.check();
    // After write+rotate: 4 existed (3 plus new one), keep=3, oldest removed.
    expect(rec.removed).toHaveLength(1);
    expect(rec.removed[0]).toContain("2026-01-01");
  });

  // brandon-daemon-limits-inw. A breach now leaves TWO files, so counting files
  // would keep one and a half post-mortems. The unit is the BREACH: its identity
  // is the shared `<stamp>-<pid>` tail, and both of an evicted breach's files go.
  test("rotation counts breaches, not files, and evicts a breach whole", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * 1024 * 1024;
    rec.existingFiles = [
      "/d/heap-2026-01-01T00-00-00-000Z-9.heapsnapshot",
      "/d/memory-2026-01-01T00-00-00-000Z-9.txt",
    ];
    await makeLimits(
      makeDeps(rec, { limitBytes: 200 * 1024 * 1024, snapshotsKeep: 1 }),
    ).check();
    // The new breach is kept whole; the older breach's BOTH files are gone.
    expect([...rec.removed].sort()).toEqual([
      "/d/heap-2026-01-01T00-00-00-000Z-9.heapsnapshot",
      "/d/memory-2026-01-01T00-00-00-000Z-9.txt",
    ]);
    expect(rec.existingFiles.sort()).toEqual([
      "/fake-snapshot-dir/heap-2026-04-01T00-00-00-000Z-4242.heapsnapshot",
      "/fake-snapshot-dir/memory-2026-04-01T00-00-00-000Z-4242.txt",
    ]);
  });

  test("a file that will not go is logged, and every other eviction still happens", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * 1024 * 1024;
    const stuck = "/d/heap-2026-01-01T00-00-00-000Z-9.heapsnapshot";
    rec.existingFiles = [
      stuck,
      "/d/memory-2026-01-01T00-00-00-000Z-9.txt",
      "/d/heap-2026-02-01T00-00-00-000Z-9.heapsnapshot",
    ];
    const remove = makeDeps(rec).removeFile;
    await makeLimits(
      makeDeps(rec, {
        limitBytes: 200 * 1024 * 1024,
        snapshotsKeep: 1,
        removeFile: (file) => {
          if (file === stuck) throw new Error("EBUSY");
          remove(file);
        },
      }),
    ).check();
    expect([...rec.removed].sort()).toEqual([
      "/d/heap-2026-02-01T00-00-00-000Z-9.heapsnapshot",
      "/d/memory-2026-01-01T00-00-00-000Z-9.txt",
    ]);
    expect(rec.logs).toContainEqual({ level: "warn", msg: `evicting ${stuck} failed: EBUSY` });
  });
});

describe("describeNextRestart", () => {
  test("null before any reading, and when far from the limit", async () => {
    const rec = newRec();
    rec.fakeRss = DEFAULT_RSS_LIMIT_MB * 0.8 * 1024 * 1024;
    const limits = makeLimits(makeDeps(rec, { memoryCharge: async () => ({ kind: "charged", measure: "phys_footprint", bytes: 50 * 1024 * 1024 }) }));
    expect(limits.describeNextRestart()).toBeNull();
    await limits.check();
    // RSS is past three quarters; the charge is not, and the charge decides.
    expect(limits.describeNextRestart()).toBeNull();
  });

  // brandon-daemon-limits-inw: the warning is the one place a human is told
  // growth is coming, so it says whether the growth is V8-side (a cache to fix)
  // or not (something the heap snapshot could never have shown them).
  test("flags the charge approaching the limit, naming its measure and the heap share", async () => {
    const rec = newRec();
    rec.fakeHeapTotal = 11 * 1024 * 1024;
    rec.fakeCharge = { kind: "charged", measure: "phys_footprint", bytes: 400 * 1024 * 1024 };
    const limits = makeLimits(makeDeps(rec));
    await limits.check();
    expect(limits.describeNextRestart()).toBe(
      "phys_footprint 400 MB approaching limit 512 MB (v8 heap 11 MB)",
    );
  });

  // brandon-unfiled-3248.ptv0: RSS the limit does not judge yet forecasts no
  // restart, however far over it is.
  test("forecasts by RSS standing in only once the limit judges it", async () => {
    const rec = newRec();
    rec.fakeHeapTotal = 11 * 1024 * 1024;
    rec.fakeCharge = { kind: "stand-in", bytes: 600 * 1024 * 1024, unread: "footprint timeout" };
    const limits = makeLimits(makeDeps(rec));
    await limits.check();
    expect(limits.describeNextRestart()).toBeNull();
    rec.fakeCharge = { kind: "stand-in", bytes: 450 * 1024 * 1024, unread: "footprint timeout" };
    for (let i = 1; i < STAND_IN_AFTER_UNREAD; i++) await limits.check();
    expect(limits.describeNextRestart()).toBe(
      "rss 450 MB (standing in: footprint timeout) approaching limit 512 MB (v8 heap 11 MB)",
    );
  });
});

// brandon-unfiled-3248.2j3m: macOS RSS counts pages malloc freed and marked
// reusable, so the verdict is the platform's charge, never RSS beside it.
describe("the charge is the verdict", () => {
  const MB = 1024 * 1024;

  test("RSS over the limit with the charge under it is no breach, and the reading is logged", async () => {
    const rec = newRec();
    rec.fakeRss = 600 * MB;
    rec.fakeHeapTotal = 150 * MB;
    rec.fakeCharge = { kind: "charged", measure: "phys_footprint", bytes: 300 * MB };
    expect(await makeLimits(makeDeps(rec)).check()).toBe(false);
    expect(rec.shutdownCalls).toEqual([]);
    expect(rec.logs).toEqual([
      {
        level: "info",
        msg: "memory measure=phys_footprint charge=300MB rss=600MB heap=150MB limit=512MB",
      },
    ]);
  });

  test("the charge over the limit breaches, the line naming the measure and RSS beside it", async () => {
    const rec = newRec();
    rec.fakeRss = 500 * MB;
    rec.fakeHeapTotal = 150 * MB;
    rec.fakeCharge = { kind: "charged", measure: "phys_footprint", bytes: 539 * MB };
    expect(await makeLimits(makeDeps(rec)).check()).toBe(true);
    expect(rec.shutdownCalls).toEqual([0]);
    expect(rec.logs).toContainEqual({
      level: "warn",
      msg: "phys_footprint 539 MB > limit 512 MB (rss 500 MB, v8 heap 150 MB); recording memory then shutting down",
    });
  });

  // brandon-unfiled-3248.ptv0: one unread footprint killed daemons whose
  // footprint never passed 435 MB, judged on the RSS standing in for it.
  const unreadOver = {
    kind: "stand-in",
    bytes: 600 * MB,
    unread: "footprint timeout",
  } as const;

  test("one unread reading over the limit is no breach, and its line counts the run", async () => {
    const rec = newRec();
    rec.fakeRss = 600 * MB;
    rec.fakeHeapTotal = 150 * MB;
    rec.fakeCharge = unreadOver;
    const limits = makeLimits(makeDeps(rec));
    expect(await limits.check()).toBe(false);
    expect(await limits.check()).toBe(false);
    expect(rec.shutdownCalls).toEqual([]);
    expect(rec.logs.map((l) => l.msg)).toEqual([
      'memory measure=rss-stand-in charge=600MB rss=600MB heap=150MB limit=512MB unread="footprint timeout" unreadRun=1/3',
      'memory measure=rss-stand-in charge=600MB rss=600MB heap=150MB limit=512MB unread="footprint timeout" unreadRun=2/3',
    ]);
  });

  test("RSS standing in for STAND_IN_AFTER_UNREAD readings running is judged, the line saying why it stands in", async () => {
    const rec = newRec();
    rec.fakeRss = 600 * MB;
    rec.fakeHeapTotal = 150 * MB;
    rec.fakeCharge = unreadOver;
    const limits = makeLimits(makeDeps(rec));
    for (let i = 1; i < STAND_IN_AFTER_UNREAD; i++) {
      expect(await limits.check()).toBe(false);
    }
    expect(await limits.check()).toBe(true);
    expect(rec.shutdownCalls).toEqual([0]);
    expect(rec.logs.slice(STAND_IN_AFTER_UNREAD - 1, STAND_IN_AFTER_UNREAD + 1)).toEqual([
      {
        level: "info",
        msg: 'memory measure=rss-stand-in charge=600MB rss=600MB heap=150MB limit=512MB unread="footprint timeout" unreadRun=3/3',
      },
      {
        level: "warn",
        msg: "rss 600 MB (standing in: footprint timeout) > limit 512 MB (rss 600 MB, v8 heap 150 MB); recording memory then shutting down",
      },
    ]);
  });

  test("a reading the platform charges ends the unread run", async () => {
    const rec = newRec();
    rec.fakeRss = 600 * MB;
    const limits = makeLimits(makeDeps(rec));
    rec.fakeCharge = unreadOver;
    await limits.check();
    await limits.check();
    rec.fakeCharge = { kind: "charged", measure: "phys_footprint", bytes: 300 * MB };
    await limits.check();
    rec.fakeCharge = unreadOver;
    expect(await limits.check()).toBe(false);
    expect(await limits.check()).toBe(false);
    expect(rec.shutdownCalls).toEqual([]);
    expect(rec.logs.at(-1)?.msg).toMatch(/ unreadRun=2\/3$/);
  });

  test("arm reads at once, and schedules the next only once the last has answered", async () => {
    jest.useFakeTimers();
    try {
      const rec = newRec();
      const answers: Array<() => void> = [];
      const limits = makeLimits(
        makeDeps(rec, {
          memoryCharge: (rss) =>
            new Promise((resolve) =>
              answers.push(() => resolve({ kind: "charged", measure: "rss", bytes: rss })),
            ),
        }),
      );
      const armed = limits.arm(1000);
      expect(answers).toHaveLength(1);
      // A probe slower than the interval delays the next, never overlaps it.
      await jest.advanceTimersByTimeAsync(5000);
      expect(answers).toHaveLength(1);
      answers[0]!();
      await jest.advanceTimersByTimeAsync(999);
      expect(answers).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(answers).toHaveLength(2);
      armed.disarm();
      answers[1]!();
      await jest.advanceTimersByTimeAsync(5000);
      expect(answers).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});


// [LAW:one-source-of-truth] These vector tables are the SAME tables
// rust-client/src/launch.rs runs against heap_cap_mb — one grammar, pinned
// from both sides. scripts/check-protocol.mjs diffs the two ACCEPT and the two
// REJECT lists, so adding a vector on one side without the other fails the
// build.
const ACCEPT: Array<[string, number]> = [
  ["1024", 1024],
  ["007", 7],
];
const REJECT = [
  "",
  " ",
  " 300 ",
  "0",
  "-5",
  "+10",
  "abc",
  "1.5",
  "512MB",
  "1_000",
  "١٢",
  "9007199254740992", // 2^53: past the safe-integer range
  "99999999999999999999",
];

describe("memoryLimitMb / heapCapMb (the memory-budget grammar)", () => {
  const env = (v: string | undefined): NodeJS.ProcessEnv =>
    v === undefined ? {} : { [RSS_LIMIT_ENV]: v };

  test("absent → the default; the cap is HEAP_CAP_OVER_RSS × the budget", async () => {
    expect(memoryLimitMb(env(undefined))).toBe(DEFAULT_RSS_LIMIT_MB);
    expect(heapCapMb(env(undefined))).toBe(DEFAULT_RSS_LIMIT_MB * HEAP_CAP_OVER_RSS);
  });

  test.each(ACCEPT)("accepts %j as %i MB", (raw, mb) => {
    expect(memoryLimitMb(env(raw))).toBe(mb);
    expect(heapCapMb(env(raw))).toBe(mb * HEAP_CAP_OVER_RSS);
  });

  test.each(REJECT)("rejects %j loudly rather than defaulting", (raw) => {
    expect(() => memoryLimitMb(env(raw))).toThrow(RSS_LIMIT_ENV);
    expect(() => heapCapMb(env(raw))).toThrow(RSS_LIMIT_ENV);
  });
});

// brandon-doctor-v62x.5mq: the post-mortems the doctor reads are the breaches
// rotation keeps — one grouping.
describe("post-mortems", () => {
  test("group by breach, newest first, each artifact under its kind, the memory report first; a file no breach wrote is none", async () => {
    expect(
      postMortemsOf([
        "/s/heap-2026-04-01T00-00-00-000Z-9.heapsnapshot",
        "/s/memory-2026-04-02T00-00-00-000Z-9.txt",
        "/s/daemon.log",
        "/s/memory-2026-04-01T00-00-00-000Z-9.txt",
        "/s/heap-2026-04-02T00-00-00-000Z-9.heapsnapshot",
        "/s/heap-2026-04-03T00-00-00-000Z-9.heapsnapshot",
      ]),
    ).toEqual([
      {
        identity: "2026-04-03T00-00-00-000Z-9",
        artifacts: { heapSnapshot: "/s/heap-2026-04-03T00-00-00-000Z-9.heapsnapshot" },
      },
      {
        identity: "2026-04-02T00-00-00-000Z-9",
        artifacts: {
          memoryReport: "/s/memory-2026-04-02T00-00-00-000Z-9.txt",
          heapSnapshot: "/s/heap-2026-04-02T00-00-00-000Z-9.heapsnapshot",
        },
      },
      {
        identity: "2026-04-01T00-00-00-000Z-9",
        artifacts: {
          memoryReport: "/s/memory-2026-04-01T00-00-00-000Z-9.txt",
          heapSnapshot: "/s/heap-2026-04-01T00-00-00-000Z-9.heapsnapshot",
        },
      },
    ]);
    // Listed heap-first, read memory-first.
    expect(
      Object.keys(
        postMortemsOf([
          "/s/heap-2026-04-01T00-00-00-000Z-9.heapsnapshot",
          "/s/memory-2026-04-01T00-00-00-000Z-9.txt",
        ])[0]!.artifacts,
      ),
    ).toEqual(["memoryReport", "heapSnapshot"]);
  });

  test("serving() reports one memory reading against the budget, and the breaches the directory keeps", async () => {
    const rec = newRec();
    rec.existingFiles.push("/snap/memory-2026-03-01T00-00-00-000Z-7.txt");
    const limits = makeLimits(makeDeps(rec, { limitBytes: 200 * 1024 * 1024 }));
    // Before any reading: none, never a number passed off as one.
    expect(limits.serving().memory).toEqual({ kind: "unmeasured" });
    await limits.check();
    expect(limits.serving()).toEqual({
      pid: rec.pid,
      memory: {
        kind: "measured",
        charge: { kind: "charged", measure: "rss", bytes: rec.fakeRss },
        rss: rec.fakeRss,
        heapTotal: rec.fakeHeapTotal,
      },
      limit: 200 * 1024 * 1024,
      postMortems: {
        kind: "ok",
        value: [
          {
            identity: "2026-03-01T00-00-00-000Z-7",
            artifacts: { memoryReport: "/snap/memory-2026-03-01T00-00-00-000Z-7.txt" },
          },
        ],
      },
    });
  });

  test("a directory that cannot be listed is a failure naming why, never no breaches", async () => {
    const rec = newRec();
    const limits = makeLimits(
      makeDeps(rec, {
        listArtifacts: () => {
          throw new Error("EACCES: permission denied, scandir '/snap'");
        },
      }),
    );
    expect(limits.serving().postMortems).toEqual({
      kind: "failed",
      reason: "EACCES: permission denied, scandir '/snap'",
    });
  });

  test("the real lister: a directory not yet made holds none; one that is a file is said so", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-"));
    const prev = process.env.XDG_STATE_HOME;
    try {
      process.env.XDG_STATE_HOME = path.join(root, "absent");
      expect(realLimitsDeps(0, () => {}).listArtifacts()).toEqual([]);
      fs.writeFileSync(path.join(root, "file"), "");
      process.env.XDG_STATE_HOME = path.join(root, "file");
      expect(() => realLimitsDeps(0, () => {}).listArtifacts()).toThrow(/ENOTDIR/);
    } finally {
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
