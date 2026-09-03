import {
  makeLimits,
  type LimitsDeps,
  DEFAULT_RSS_LIMIT_MB,
  HEAP_CAP_OVER_RSS,
  RSS_LIMIT_ENV,
  rssLimitMb,
  heapCapMb,
} from "../src/daemon/limits";

interface Recorder {
  shutdownCalls: number[];
  snapshotsWritten: string[];
  removed: string[];
  logs: Array<{ level: string; msg: string }>;
  fakeRss: number;
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
    rssBytes: () => rec.fakeRss,
    writeHeapSnapshot: (file) => {
      rec.snapshotsWritten.push(file);
      rec.existingFiles.push(file);
      return file;
    },
    listSnapshots: () => [...rec.existingFiles],
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
    fakeRss: 50 * 1024 * 1024,
    fakeNow: Date.parse("2026-04-01T00:00:00Z"),
    startedAtMs: Date.parse("2026-04-01T00:00:00Z"),
    pid: 4242,
    snapshotDir: "/fake-snapshot-dir",
    existingFiles: [],
  };
}

describe("limits.checkRss", () => {
  test("under limit: no shutdown, no snapshot", () => {
    const rec = newRec();
    const limits = makeLimits(makeDeps(rec));
    expect(limits.checkRss()).toBe(false);
    expect(rec.shutdownCalls).toEqual([]);
    expect(rec.snapshotsWritten).toEqual([]);
  });

  test("over limit: writes snapshot then shuts down", () => {
    const rec = newRec();
    rec.fakeRss = 250 * 1024 * 1024;
    const limits = makeLimits(makeDeps(rec, { rssLimitBytes: 200 * 1024 * 1024 }));
    expect(limits.checkRss()).toBe(true);
    expect(rec.snapshotsWritten).toHaveLength(1);
    expect(rec.shutdownCalls).toEqual([0]);
  });

  test("only triggers once even if RSS stays high", () => {
    const rec = newRec();
    rec.fakeRss = 250 * 1024 * 1024;
    const limits = makeLimits(makeDeps(rec, { rssLimitBytes: 200 * 1024 * 1024 }));
    limits.checkRss();
    limits.checkRss();
    limits.checkRss();
    expect(rec.shutdownCalls).toEqual([0]);
    expect(rec.snapshotsWritten).toHaveLength(1);
  });

  test("snapshot filename is written under the injected dir, not the real daemonDir", () => {
    const rec = newRec();
    rec.fakeRss = 250 * 1024 * 1024;
    const limits = makeLimits(makeDeps(rec, { rssLimitBytes: 200 * 1024 * 1024 }));
    limits.checkRss();
    expect(rec.snapshotsWritten[0]).toMatch(
      /^\/fake-snapshot-dir\/heap-.*\.heapsnapshot$/,
    );
    // No ambient logging: every line landed in the injected sink.
    expect(rec.logs.map((l) => l.msg)).toContain(
      "heap snapshot written: /fake-snapshot-dir/heap-2026-04-01T00-00-00-000Z-4242.heapsnapshot",
    );
  });

  test("filename carries the pid so overlapping daemons never collide", () => {
    // Two daemons hit the wall at the SAME instant (identical fakeNow); only
    // the pid distinguishes their snapshots, so neither clobbers the other.
    const a = newRec();
    a.fakeRss = 250 * 1024 * 1024;
    a.pid = 111;
    makeLimits(makeDeps(a, { rssLimitBytes: 200 * 1024 * 1024 })).checkRss();

    const b = newRec();
    b.fakeRss = 250 * 1024 * 1024;
    b.pid = 222;
    makeLimits(makeDeps(b, { rssLimitBytes: 200 * 1024 * 1024 })).checkRss();

    expect(a.snapshotsWritten[0]).toContain("-111.heapsnapshot");
    expect(b.snapshotsWritten[0]).toContain("-222.heapsnapshot");
    expect(a.snapshotsWritten[0]).not.toBe(b.snapshotsWritten[0]);
  });
});


describe("heap snapshot rotation", () => {
  test("keeps only the 3 newest snapshots", () => {
    const rec = newRec();
    rec.fakeRss = 250 * 1024 * 1024;
    rec.existingFiles = [
      "/d/heap-2026-01-01T00-00-00-000Z.heapsnapshot",
      "/d/heap-2026-02-01T00-00-00-000Z.heapsnapshot",
      "/d/heap-2026-03-01T00-00-00-000Z.heapsnapshot",
    ];
    const limits = makeLimits(makeDeps(rec, { rssLimitBytes: 200 * 1024 * 1024 }));
    limits.checkRss();
    // After write+rotate: 4 existed (3 plus new one), keep=3, oldest removed.
    expect(rec.removed).toHaveLength(1);
    expect(rec.removed[0]).toContain("2026-01-01");
  });
});

describe("describeNextRestart", () => {
  test("null when far from limits", () => {
    const rec = newRec();
    rec.fakeRss = 50 * 1024 * 1024;
    const limits = makeLimits(makeDeps(rec));
    expect(limits.describeNextRestart()).toBeNull();
  });

  test("flags rss approaching limit", () => {
    const rec = newRec();
    rec.fakeRss = DEFAULT_RSS_LIMIT_MB * 0.8 * 1024 * 1024; // > 75% of the default
    const limits = makeLimits(makeDeps(rec));
    expect(limits.describeNextRestart()).toContain("rss");
  });

  test("returns null when rss is healthy", () => {
    const rec = newRec();
    rec.fakeRss = 50 * 1024 * 1024; // well under limit
    const limits = makeLimits(makeDeps(rec));
    expect(limits.describeNextRestart()).toBeNull();
  });
});

// [LAW:one-source-of-truth] These vector tables are the SAME tables
// rust-client/src/launch.rs runs against heap_cap_mb — one grammar, pinned
// from both sides. scripts/check-protocol.mjs diffs the two ACCEPT and the two
// REJECT lists, so adding a vector on one side without the other fails the
// build.
const ACCEPT: Array<[string, number]> = [
  ["1024", 1024],
  [" 300 ", 300],
  ["007", 7],
];
const REJECT = [
  "",
  " ",
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

describe("rssLimitMb / heapCapMb (the memory-budget grammar)", () => {
  const env = (v: string | undefined): NodeJS.ProcessEnv =>
    v === undefined ? {} : { [RSS_LIMIT_ENV]: v };

  test("absent → the default; the cap is HEAP_CAP_OVER_RSS × the budget", () => {
    expect(rssLimitMb(env(undefined))).toBe(DEFAULT_RSS_LIMIT_MB);
    expect(heapCapMb(env(undefined))).toBe(DEFAULT_RSS_LIMIT_MB * HEAP_CAP_OVER_RSS);
  });

  test.each(ACCEPT)("accepts %j as %i MB", (raw, mb) => {
    expect(rssLimitMb(env(raw))).toBe(mb);
    expect(heapCapMb(env(raw))).toBe(mb * HEAP_CAP_OVER_RSS);
  });

  test.each(REJECT)("rejects %j loudly rather than defaulting", (raw) => {
    expect(() => rssLimitMb(env(raw))).toThrow(RSS_LIMIT_ENV);
    expect(() => heapCapMb(env(raw))).toThrow(RSS_LIMIT_ENV);
  });
});
