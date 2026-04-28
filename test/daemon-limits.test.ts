import { makeLimits, type LimitsDeps } from "../src/daemon/limits";

interface Recorder {
  shutdownCalls: number[];
  snapshotsWritten: string[];
  removed: string[];
  fakeRss: number;
  fakeNow: number;
  startedAtMs: number;
  existingFiles: string[];
}

function makeDeps(rec: Recorder, overrides: Partial<LimitsDeps> = {}): LimitsDeps {
  return {
    now: () => rec.fakeNow,
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
    fakeRss: 50 * 1024 * 1024,
    fakeNow: Date.parse("2026-04-01T00:00:00Z"),
    startedAtMs: Date.parse("2026-04-01T00:00:00Z"),
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
    const limits = makeLimits(makeDeps(rec));
    expect(limits.checkRss()).toBe(true);
    expect(rec.snapshotsWritten).toHaveLength(1);
    expect(rec.shutdownCalls).toEqual([0]);
  });

  test("only triggers once even if RSS stays high", () => {
    const rec = newRec();
    rec.fakeRss = 250 * 1024 * 1024;
    const limits = makeLimits(makeDeps(rec));
    limits.checkRss();
    limits.checkRss();
    limits.checkRss();
    expect(rec.shutdownCalls).toEqual([0]);
    expect(rec.snapshotsWritten).toHaveLength(1);
  });
});

describe("limits.checkAge", () => {
  test("under age limit: no shutdown", () => {
    const rec = newRec();
    rec.fakeNow = rec.startedAtMs + 60_000;
    const limits = makeLimits(makeDeps(rec));
    expect(limits.checkAge()).toBe(false);
    expect(rec.shutdownCalls).toEqual([]);
  });

  test("over 24h: shuts down", () => {
    const rec = newRec();
    rec.fakeNow = rec.startedAtMs + 25 * 60 * 60 * 1000;
    const limits = makeLimits(makeDeps(rec));
    expect(limits.checkAge()).toBe(true);
    expect(rec.shutdownCalls).toEqual([0]);
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
    const limits = makeLimits(makeDeps(rec));
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
    rec.fakeRss = 180 * 1024 * 1024; // > 75% of 200MB
    const limits = makeLimits(makeDeps(rec));
    expect(limits.describeNextRestart()).toContain("rss");
  });

  test("flags age approaching limit", () => {
    const rec = newRec();
    rec.fakeNow = rec.startedAtMs + 20 * 60 * 60 * 1000; // 20h, > 75% of 24h
    const limits = makeLimits(makeDeps(rec));
    expect(limits.describeNextRestart()).toContain("age");
  });
});
