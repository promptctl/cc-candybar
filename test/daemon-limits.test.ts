import { until } from "../scripts/lib/until";
import { unscriptedLauncher } from "../scripts/lib/draw-fixtures/fake-launcher";
import {
  makeLimits,
  type LimitsDeps,
  type RendererMemory,
  DEFAULT_RSS_LIMIT_MB,
  HEAP_CAP_OVER_RSS,
  RSS_LIMIT_ENV,
  memoryLimitMb,
  heapCapMb,
  listPostMortems,
  postMortemsOf,
  realLimitsDeps,
} from "../src/daemon/limits";
import {
  BYTES_PER_MB as MB,
  type MemoryCharge,
  type OwnUsage,
} from "../src/daemon/foundations/memory-limit";
import type { ReadProcess } from "../src/daemon/memory-report";
import {
  MAIN_RENDERER,
  rendererNameOf,
  type RendererName,
} from "../src/daemon/foundations/renderer-name";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { systemTimekeeper } from "../scripts/lib/system-clock";

// A renderer process, as the backstop is handed it.
interface RendererFake {
  name: RendererName;
  // Its spawn; absent, its first.
  generation?: number;
  pid: number;
  usage: OwnUsage;
  // What the platform charges it; absent, its RSS as Linux charges it.
  charge?: MemoryCharge;
}

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
  // What the platform charges the host; absent, RSS is the charge (Linux).
  fakeCharge?: MemoryCharge;
  fakeHeapTotal: number;
  fakeNow: number;
  startedAtMs: number;
  pid: number;
  snapshotDir: string;
  existingFiles: string[];
  renderers: RendererFake[];
  // Each renderer the backstop ended, and why.
  ended: Array<{ name: RendererName; why: string }>;
  chargedPids: number[][];
  capturedPids: number[];
}

function chargeOf(rec: Recorder, { pid, usage }: ReadProcess): MemoryCharge {
  const charge =
    pid === rec.pid
      ? rec.fakeCharge
      : rec.renderers.find((renderer) => renderer.pid === pid)!.charge;
  return (
    charge ??
    (usage.kind === "read"
      ? { kind: "charged", measure: "rss", bytes: usage.sizes.rss }
      : { kind: "unread", unread: usage.why })
  );
}

function makeDeps(
  rec: Recorder,
  overrides: Partial<LimitsDeps & RendererMemory> = {},
): LimitsDeps & RendererMemory {
  return {
    clock: {
      now: () => rec.fakeNow,
      after: systemTimekeeper.after,
      detach: systemTimekeeper.detach,
    },
    pid: rec.pid,
    snapshotDir: rec.snapshotDir,
    log: (level, msg) => rec.logs.push({ level, msg }),
    memoryBytes: () => ({ rss: rec.fakeRss, heapTotal: rec.fakeHeapTotal }),
    memoryCharge: async (processes) => {
      rec.chargedPids.push(processes.map(({ pid }) => pid));
      return processes.map((process) => ({
        process,
        charge: chargeOf(rec, process),
      }));
    },
    renderers: () =>
      rec.renderers.map(({ name, generation = 1, pid, usage }) => ({
        name,
        generation,
        pid,
        usage,
        heapSnapshot: async (file) => {
          rec.order.push("write-renderer-heap");
          rec.snapshotsWritten.push(file);
          rec.existingFiles.push(file);
        },
        end: (why) => rec.ended.push({ name, why }),
      })),
    captureMemoryReport: async (pid) => {
      rec.order.push("capture");
      rec.capturedPids.push(pid);
      if (rec.captureThrows) throw new Error("footprint exploded");
      return `# memory report from: footprint -p ${pid}\n118 MB tag 16`;
    },
    writeMemoryReport: (file, text) => {
      rec.order.push("write-report");
      if (rec.reportWriteThrows) throw new Error("EACCES");
      rec.reportsWritten.push({ file, text });
      rec.existingFiles.push(file);
    },
    writeLogNow: () => {
      rec.order.push("write-log");
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
    // The fixture's own limit: these tests judge readings against a limit they
    // state, not whatever the shipped default is.
    limitBytes: FIXTURE_LIMIT_MB * MB,
    ...overrides,
  };
}

const FIXTURE_LIMIT_MB = 512;

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
    fakeRss: 50 * MB,
    fakeHeapTotal: 20 * MB,
    fakeNow: Date.parse("2026-04-01T00:00:00Z"),
    startedAtMs: Date.parse("2026-04-01T00:00:00Z"),
    pid: 4242,
    snapshotDir: "/fake-snapshot-dir",
    existingFiles: [],
    renderers: [],
    ended: [],
    chargedPids: [],
    capturedPids: [],
  };
}

const WORKTREE = rendererNameOf("worktree");
const rendererAt = (
  name: RendererName,
  pid: number,
  rss: number,
): RendererFake => ({
  name,
  pid,
  usage: { kind: "read", sizes: { rss, heapTotal: 60 * MB } },
});

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
    rec.fakeRss = 250 * MB;
    const limits = makeLimits(makeDeps(rec, { limitBytes: 200 * MB }));
    expect(await limits.check()).toBe(true);
    expect(rec.snapshotsWritten).toHaveLength(1);
    expect(rec.shutdownCalls).toEqual([0]);
  });

  test("each process is judged on its own charge, read in one call: none over alone is no breach", async () => {
    const rec = newRec();
    rec.fakeRss = 150 * MB;
    rec.renderers = [
      rendererAt(MAIN_RENDERER, 4343, 150 * MB),
      rendererAt(WORKTREE, 4444, 150 * MB),
    ];
    const limits = makeLimits(makeDeps(rec, { limitBytes: 200 * MB }));
    expect(await limits.check()).toBe(false);
    expect(rec.chargedPids).toEqual([[4242, 4343, 4444]]);
    expect(rec.shutdownCalls).toEqual([]);
    expect(rec.ended).toEqual([]);
  });

  test("a renderer over the limit is recorded under its own identity and ended alone, and the host serves on", async () => {
    const rec = newRec();
    rec.renderers = [
      rendererAt(MAIN_RENDERER, 4343, 50 * MB),
      rendererAt(WORKTREE, 4444, 250 * MB),
    ];
    const limits = makeLimits(makeDeps(rec, { limitBytes: 200 * MB }));
    expect(await limits.check()).toBe(false);
    expect(rec.order).toEqual([
      "capture",
      "write-report",
      "write-renderer-heap",
    ]);
    expect(rec.capturedPids).toEqual([4444]);
    expect(rec.reportsWritten.map(({ file }) => file)).toEqual([
      "/fake-snapshot-dir/memory-2026-04-01T00-00-00-000Z-renderer-worktree-4444.txt",
    ]);
    expect(rec.snapshotsWritten).toEqual([
      "/fake-snapshot-dir/heap-2026-04-01T00-00-00-000Z-renderer-worktree-4444.heapsnapshot",
    ]);
    expect(rec.ended).toEqual([
      {
        name: WORKTREE,
        why: "passed its memory limit: rss 250 MB > limit 200 MB",
      },
    ]);
    expect(rec.shutdownCalls).toEqual([]);
    expect(rec.logs).toContainEqual({
      level: "warn",
      msg: "renderer worktree passed its memory limit: rss 250 MB > limit 200 MB (rss 250 MB, v8 heap 60 MB); recording its memory, then ending it",
    });
    // The backstop stays armed: the next reading judges again.
    rec.renderers = [rendererAt(MAIN_RENDERER, 4343, 250 * MB)];
    expect(await limits.check()).toBe(false);
    expect(rec.ended.map(({ name }) => name)).toEqual([
      WORKTREE,
      MAIN_RENDERER,
    ]);
  });

  test("the host over the limit ends the daemon, recording only its own memory", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * MB;
    rec.renderers = [rendererAt(MAIN_RENDERER, 4343, 250 * MB)];
    expect(
      await makeLimits(makeDeps(rec, { limitBytes: 200 * MB })).check(),
    ).toBe(true);
    expect(rec.capturedPids).toEqual([4242]);
    expect(rec.snapshotsWritten).toEqual([
      "/fake-snapshot-dir/heap-2026-04-01T00-00-00-000Z-host-4242.heapsnapshot",
    ]);
    expect(rec.shutdownCalls).toEqual([0]);
    // The daemon's end ends every renderer with it.
    expect(rec.ended).toEqual([]);
  });

  test("only triggers once even if RSS stays high", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * MB;
    const limits = makeLimits(makeDeps(rec, { limitBytes: 200 * MB }));
    await limits.check();
    await limits.check();
    await limits.check();
    expect(rec.shutdownCalls).toEqual([0]);
    expect(rec.snapshotsWritten).toHaveLength(1);
  });

  test("callers overlapping one slow reading share it, so a breach is recorded once", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * MB;
    let answer: () => void = () => {};
    let probes = 0;
    const charged = makeDeps(rec).memoryCharge;
    const limits = makeLimits(
      makeDeps(rec, {
        limitBytes: 200 * MB,
        memoryCharge: (processes) => {
          probes++;
          return new Promise(
            (resolve) => (answer = () => resolve(charged(processes))),
          );
        },
      }),
    );
    const both = Promise.all([limits.check(), limits.check()]);
    answer();
    expect(await both).toEqual([true, true]);
    expect(probes).toBe(1);
    expect(rec.shutdownCalls).toEqual([0]);
    expect(rec.snapshotsWritten).toHaveLength(1);
    expect(rec.reportsWritten).toHaveLength(1);
  });

  test("the attribution completes before the snapshot starts", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * MB;
    let answer!: (report: string) => void;
    const limits = makeLimits(
      makeDeps(rec, {
        limitBytes: 200 * MB,
        captureMemoryReport: () => new Promise((resolve) => (answer = resolve)),
      }),
    );
    const checking = limits.check();
    await until(() => answer !== undefined, "the attribution to start");
    expect(rec.snapshotsWritten).toEqual([]);
    answer("report");
    expect(await checking).toBe(true);
    expect(rec.reportsWritten).toHaveLength(1);
    expect(rec.snapshotsWritten).toHaveLength(1);
    expect(rec.shutdownCalls).toEqual([0]);
  });

  test("a close during the attribution writes no snapshot and does not shut down", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * MB;
    let answer!: (report: string) => void;
    const limits = makeLimits(
      makeDeps(rec, {
        limitBytes: 200 * MB,
        captureMemoryReport: () => new Promise((resolve) => (answer = resolve)),
      }),
    );
    const checking = limits.check();
    await until(() => answer !== undefined, "the attribution to start");
    limits.disarm();
    answer("report");
    expect(await checking).toBe(false);
    expect(rec.snapshotsWritten).toEqual([]);
    expect(rec.shutdownCalls).toEqual([]);
    expect(rec.logs.map((l) => l.msg)).toContain(
      "daemon closed during the host's breach: no snapshot, no end",
    );
  });

  test("a close during a renderer's heap snapshot does not end it", async () => {
    const rec = newRec();
    rec.renderers = [rendererAt(WORKTREE, 4444, 250 * MB)];
    let written!: () => void;
    const listed = makeDeps(rec).renderers;
    const limits = makeLimits(
      makeDeps(rec, {
        limitBytes: 200 * MB,
        renderers: () =>
          listed().map((renderer) => ({
            ...renderer,
            heapSnapshot: () =>
              new Promise<void>((resolve) => (written = resolve)),
          })),
      }),
    );
    const checking = limits.check();
    await until(
      () => written !== undefined,
      "the renderer's snapshot to start",
    );
    limits.disarm();
    written();
    expect(await checking).toBe(false);
    expect(rec.ended).toEqual([]);
    expect(rec.logs.map((l) => l.msg)).toContain(
      "daemon closed during the renderer worktree's breach: no snapshot, no end",
    );
  });

  test("snapshot filename is written under the injected dir, not the real daemonDir", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * MB;
    const limits = makeLimits(makeDeps(rec, { limitBytes: 200 * MB }));
    await limits.check();
    expect(rec.snapshotsWritten[0]).toMatch(
      /^\/fake-snapshot-dir\/heap-.*\.heapsnapshot$/,
    );
    // No ambient logging: every line landed in the injected sink.
    expect(rec.logs.map((l) => l.msg)).toContain(
      "heap snapshot written: /fake-snapshot-dir/heap-2026-04-01T00-00-00-000Z-host-4242.heapsnapshot",
    );
  });

  test("filename carries the pid so overlapping daemons never collide", async () => {
    // Two daemons hit the wall at the SAME instant (identical fakeNow); only
    // the pid distinguishes their snapshots, so neither clobbers the other.
    const a = newRec();
    a.fakeRss = 250 * MB;
    a.pid = 111;
    await makeLimits(makeDeps(a, { limitBytes: 200 * MB })).check();

    const b = newRec();
    b.fakeRss = 250 * MB;
    b.pid = 222;
    await makeLimits(makeDeps(b, { limitBytes: 200 * MB })).check();

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
    rec.fakeRss = 250 * MB;
    await makeLimits(makeDeps(rec, { limitBytes: 200 * MB })).check();
  }

  test("the captured attribution is written beside the snapshot, same identity", async () => {
    const rec = newRec();
    await breach(rec);
    expect(rec.reportsWritten).toHaveLength(1);
    expect(rec.reportsWritten[0]!.file).toBe(
      "/fake-snapshot-dir/memory-2026-04-01T00-00-00-000Z-host-4242.txt",
    );
    // The captured text reaches the file verbatim — the capture and the write
    // are separate deps precisely so this is observable.
    expect(rec.reportsWritten[0]!.text).toContain("118 MB tag 16");
    // Same stamp and pid as the snapshot: one breach, one identity, two files.
    expect(rec.snapshotsWritten[0]).toBe(
      "/fake-snapshot-dir/heap-2026-04-01T00-00-00-000Z-host-4242.heapsnapshot",
    );
  });

  // [LAW:no-ambient-temporal-coupling] Ordering that matters is stated, not
  // hoped for: writing a heap snapshot allocates and can move hundreds of MB, so
  // an attribution taken afterwards would describe the state the SNAPSHOT
  // produced rather than the state that tripped the limit.
  test("the attribution is captured before the snapshot rewrites the state", async () => {
    const rec = newRec();
    await breach(rec);
    // What the log holds about the breach is on disk before the snapshot
    // holds the loop.
    expect(rec.order).toEqual([
      "capture",
      "write-report",
      "write-log",
      "write-heap",
    ]);
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
    rec.fakeHeapTotal = 30 * MB;
    await breach(rec);
    const warn = rec.logs.find((l) => l.level === "warn")!.msg;
    expect(warn).toContain("rss 250 MB > limit 200 MB");
    expect(warn).toContain("v8 heap 30 MB");
  });
});

describe("heap snapshot rotation", () => {
  test("keeps only the 3 newest snapshots", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * MB;
    rec.existingFiles = [
      "/d/heap-2026-01-01T00-00-00-000Z-1.heapsnapshot",
      "/d/heap-2026-02-01T00-00-00-000Z-1.heapsnapshot",
      "/d/heap-2026-03-01T00-00-00-000Z-1.heapsnapshot",
    ];
    const limits = makeLimits(makeDeps(rec, { limitBytes: 200 * MB }));
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
    rec.fakeRss = 250 * MB;
    rec.existingFiles = [
      "/d/heap-2026-01-01T00-00-00-000Z-9.heapsnapshot",
      "/d/memory-2026-01-01T00-00-00-000Z-9.txt",
    ];
    await makeLimits(
      makeDeps(rec, { limitBytes: 200 * MB, snapshotsKeep: 1 }),
    ).check();
    // The new breach is kept whole; the older breach's BOTH files are gone.
    expect([...rec.removed].sort()).toEqual([
      "/d/heap-2026-01-01T00-00-00-000Z-9.heapsnapshot",
      "/d/memory-2026-01-01T00-00-00-000Z-9.txt",
    ]);
    expect(rec.existingFiles.sort()).toEqual([
      "/fake-snapshot-dir/heap-2026-04-01T00-00-00-000Z-host-4242.heapsnapshot",
      "/fake-snapshot-dir/memory-2026-04-01T00-00-00-000Z-host-4242.txt",
    ]);
  });

  test("a file that will not go is logged, and every other eviction still happens", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * MB;
    const stuck = "/d/heap-2026-01-01T00-00-00-000Z-9.heapsnapshot";
    rec.existingFiles = [
      stuck,
      "/d/memory-2026-01-01T00-00-00-000Z-9.txt",
      "/d/heap-2026-02-01T00-00-00-000Z-9.heapsnapshot",
    ];
    const remove = makeDeps(rec).removeFile;
    await makeLimits(
      makeDeps(rec, {
        limitBytes: 200 * MB,
        snapshotsKeep: 1,
        removeFile: (file: string) => {
          if (file === stuck) throw new Error("EBUSY");
          remove(file);
        },
      }),
    ).check();
    expect([...rec.removed].sort()).toEqual([
      "/d/heap-2026-02-01T00-00-00-000Z-9.heapsnapshot",
      "/d/memory-2026-01-01T00-00-00-000Z-9.txt",
    ]);
    expect(rec.logs).toContainEqual({
      level: "warn",
      msg: `evicting ${stuck} failed: EBUSY`,
    });
  });
});

const MAIN_FIRST = { name: MAIN_RENDERER, generation: 1, pid: 4343 };

describe("a process's memory", () => {
  test("unmeasured before any reading, and for a process no reading has charged", async () => {
    const rec = newRec();
    const limits = makeLimits(makeDeps(rec, { limitBytes: 200 * MB }));
    // Before any reading: none, never a number passed off as one.
    expect(limits.host()).toEqual({
      pid: rec.pid,
      memory: { kind: "unmeasured" },
      limit: 200 * MB,
    });
    await limits.check();
    expect(limits.host()).toEqual({
      pid: rec.pid,
      memory: {
        kind: "measured",
        charge: { kind: "charged", measure: "rss", bytes: rec.fakeRss },
        usage: {
          kind: "read",
          sizes: { rss: rec.fakeRss, heapTotal: rec.fakeHeapTotal },
        },
      },
      limit: 200 * MB,
    });
    // A renderer started since the last reading.
    expect(limits.renderer(MAIN_FIRST).memory).toEqual({ kind: "unmeasured" });
  });

  test("each process's reading is its own", async () => {
    const rec = newRec();
    rec.fakeCharge = {
      kind: "charged",
      measure: "phys_footprint",
      bytes: 50 * MB,
    };
    rec.renderers = [
      {
        ...rendererAt(MAIN_RENDERER, 4343, 450 * MB),
        charge: { kind: "charged", measure: "phys_footprint", bytes: 400 * MB },
      },
    ];
    const limits = makeLimits(makeDeps(rec));
    await limits.check();
    expect(limits.host().memory).toMatchObject({
      charge: { bytes: 50 * MB },
    });
    expect(limits.renderer(MAIN_FIRST).memory).toEqual({
      kind: "measured",
      charge: { kind: "charged", measure: "phys_footprint", bytes: 400 * MB },
      usage: { kind: "read", sizes: { rss: 450 * MB, heapTotal: 60 * MB } },
    });
  });

  test("a later spawn the OS hands an earlier one's pid is a process of its own: no reading of the earlier is its, nor its gap", async () => {
    const rec = newRec();
    rec.renderers = [
      {
        ...rendererAt(MAIN_RENDERER, 4343, 450 * MB),
        charge: { kind: "charged", measure: "phys_footprint", bytes: 300 * MB },
      },
    ];
    const limits = makeLimits(makeDeps(rec));
    await limits.check();
    const second = { ...MAIN_FIRST, generation: 2 };
    expect(limits.renderer(second).memory).toEqual({ kind: "unmeasured" });
    rec.renderers = [
      {
        ...rendererAt(MAIN_RENDERER, 4343, 600 * MB),
        generation: 2,
        charge: {
          kind: "stand-in",
          bytes: 600 * MB,
          unread: "footprint timeout",
        },
      },
    ];
    await limits.check();
    // Judged on its own RSS whole: the 150 MB gap was the first spawn's.
    expect(limits.renderer(second).memory).toMatchObject({
      charge: { kind: "stand-in", bytes: 600 * MB, gap: 0 },
    });
    expect(rec.ended).toEqual([
      {
        name: MAIN_RENDERER,
        why: "passed its memory limit: rss 600 MB (standing in: footprint timeout) > limit 512 MB",
      },
    ]);
  });

  test("a renderer no ping has read is charged from its spawn, and one nothing could charge is said, never judged", async () => {
    const rec = newRec();
    const unread: OwnUsage = {
      kind: "unread",
      why: "no ping has answered yet",
    };
    rec.renderers = [
      {
        name: MAIN_RENDERER,
        pid: 4343,
        usage: unread,
        charge: { kind: "charged", measure: "phys_footprint", bytes: 700 * MB },
      },
      { name: WORKTREE, pid: 4444, usage: unread },
    ];
    expect(await makeLimits(makeDeps(rec)).check()).toBe(false);
    expect(rec.chargedPids).toEqual([[rec.pid, 4343, 4444]]);
    expect(rec.ended).toEqual([
      {
        name: MAIN_RENDERER,
        why: "passed its memory limit: phys_footprint 700 MB > limit 512 MB",
      },
    ]);
    expect(rec.logs).toContainEqual({
      level: "info",
      msg: 'memory limit=512MB host.pid=4242 host.measure=rss host.charge=50MB host.rss=50MB host.heap=20MB renderer.main.pid=4343 renderer.main.measure=phys_footprint renderer.main.charge=700MB renderer.worktree.pid=4444 renderer.worktree.measure=unread renderer.worktree.gap=0MB renderer.worktree.unread="no ping has answered yet"',
    });
    expect(rec.logs).toContainEqual({
      level: "warn",
      msg: "renderer main passed its memory limit: phys_footprint 700 MB > limit 512 MB (no sizes: no ping has answered yet); recording its memory, then ending it",
    });
  });
});

// brandon-unfiled-3248.2j3m: macOS RSS counts pages malloc freed and marked
// reusable, so the verdict is the platform's charge, never RSS beside it.
describe("the charge is the verdict", () => {
  test("RSS over the limit with the charge under it is no breach, and the reading is logged", async () => {
    const rec = newRec();
    rec.fakeRss = 600 * MB;
    rec.fakeHeapTotal = 150 * MB;
    rec.fakeCharge = {
      kind: "charged",
      measure: "phys_footprint",
      bytes: 300 * MB,
    };
    rec.renderers = [rendererAt(MAIN_RENDERER, 4343, 100 * MB)];
    expect(await makeLimits(makeDeps(rec)).check()).toBe(false);
    expect(rec.shutdownCalls).toEqual([]);
    expect(rec.logs).toEqual([
      {
        level: "info",
        msg: "memory limit=512MB host.pid=4242 host.measure=phys_footprint host.charge=300MB host.rss=600MB host.heap=150MB renderer.main.pid=4343 renderer.main.measure=rss renderer.main.charge=100MB renderer.main.rss=100MB renderer.main.heap=60MB",
      },
    ]);
  });

  test("the charge over the limit breaches, the line naming the measure and RSS beside it", async () => {
    const rec = newRec();
    rec.fakeRss = 500 * MB;
    rec.fakeHeapTotal = 150 * MB;
    rec.fakeCharge = {
      kind: "charged",
      measure: "phys_footprint",
      bytes: 539 * MB,
    };
    expect(await makeLimits(makeDeps(rec)).check()).toBe(true);
    expect(rec.shutdownCalls).toEqual([0]);
    expect(rec.logs).toContainEqual({
      level: "warn",
      msg: "host passed its memory limit: phys_footprint 539 MB > limit 512 MB (rss 500 MB, v8 heap 150 MB); recording its memory, then ending it",
    });
  });

  // brandon-unfiled-3248.ptv0: one unread footprint killed daemons whose
  // footprint never passed 435 MB, judged on the raw RSS standing in for it.
  // The probe's stand-in is RSS itself, as `footprintCharge` answers it.
  const read = (rec: Recorder, rss: number, footprint: number | null): void => {
    rec.fakeRss = rss;
    rec.fakeCharge =
      footprint === null
        ? { kind: "stand-in", bytes: rss, unread: "footprint timeout" }
        : { kind: "charged", measure: "phys_footprint", bytes: footprint };
  };

  test("RSS standing in is judged less the gap the last charged reading measured, through every stand-in since", async () => {
    const rec = newRec();
    rec.fakeHeapTotal = 150 * MB;
    const limits = makeLimits(makeDeps(rec));
    read(rec, 450 * MB, 300 * MB);
    await limits.check();
    read(rec, 600 * MB, null);
    expect(await limits.check()).toBe(false);
    read(rec, 620 * MB, null);
    expect(await limits.check()).toBe(false);
    expect(rec.shutdownCalls).toEqual([]);
    expect(rec.logs.slice(1).map((l) => l.msg)).toEqual([
      'memory limit=512MB host.pid=4242 host.measure=rss-stand-in host.charge=450MB host.rss=600MB host.heap=150MB host.gap=150MB host.unread="footprint timeout"',
      'memory limit=512MB host.pid=4242 host.measure=rss-stand-in host.charge=470MB host.rss=620MB host.heap=150MB host.gap=150MB host.unread="footprint timeout"',
    ]);
  });

  test("a process's stand-in is judged less its own gap, never another's", async () => {
    const rec = newRec();
    read(rec, 450 * MB, 300 * MB);
    const limits = makeLimits(makeDeps(rec));
    await limits.check();
    // The renderer's first reading stands in whole: no charged reading of its
    // own measured a gap, and the host's is the host's.
    rec.renderers = [
      {
        ...rendererAt(MAIN_RENDERER, 4343, 600 * MB),
        charge: {
          kind: "stand-in",
          bytes: 600 * MB,
          unread: "footprint timeout",
        },
      },
    ];
    expect(await limits.check()).toBe(false);
    expect(rec.ended).toEqual([
      {
        name: MAIN_RENDERER,
        why: "passed its memory limit: rss 600 MB (standing in: footprint timeout) > limit 512 MB",
      },
    ]);
  });

  test("a runaway is judged at once, though its footprint went unread", async () => {
    const rec = newRec();
    rec.fakeHeapTotal = 150 * MB;
    const limits = makeLimits(makeDeps(rec));
    read(rec, 450 * MB, 300 * MB);
    await limits.check();
    read(rec, 2000 * MB, null);
    expect(await limits.check()).toBe(true);
    expect(rec.shutdownCalls).toEqual([0]);
    expect(rec.logs).toContainEqual({
      level: "warn",
      msg: "host passed its memory limit: rss 2000 MB less its last 150 MB gap (standing in: footprint timeout) > limit 512 MB (rss 2000 MB, v8 heap 150 MB); recording its memory, then ending it",
    });
  });

  test("with no footprint ever read, RSS is judged whole", async () => {
    const rec = newRec();
    rec.fakeHeapTotal = 150 * MB;
    read(rec, 600 * MB, null);
    expect(await makeLimits(makeDeps(rec)).check()).toBe(true);
    expect(rec.logs.slice(0, 2).map((l) => l.msg)).toEqual([
      'memory limit=512MB host.pid=4242 host.measure=rss-stand-in host.charge=600MB host.rss=600MB host.heap=150MB host.gap=0MB host.unread="footprint timeout"',
      "host passed its memory limit: rss 600 MB (standing in: footprint timeout) > limit 512 MB (rss 600 MB, v8 heap 150 MB); recording its memory, then ending it",
    ]);
  });

  test("a charged reading over the limit after a stand-in breaches at once", async () => {
    const rec = newRec();
    const limits = makeLimits(makeDeps(rec));
    read(rec, 450 * MB, 300 * MB);
    await limits.check();
    read(rec, 450 * MB, null);
    expect(await limits.check()).toBe(false);
    read(rec, 700 * MB, 600 * MB);
    expect(await limits.check()).toBe(true);
    expect(rec.shutdownCalls).toEqual([0]);
  });

  test("arm reads at once, and schedules the next only once the last has answered", async () => {
    jest.useFakeTimers();
    try {
      const rec = newRec();
      const answers: Array<() => void> = [];
      const charged = makeDeps(rec).memoryCharge;
      const limits = makeLimits(
        makeDeps(rec, {
          memoryCharge: (processes) =>
            new Promise((resolve) =>
              answers.push(() => resolve(charged(processes))),
            ),
        }),
      );
      limits.arm(1000);
      expect(answers).toHaveLength(1);
      // A probe slower than the interval delays the next, never overlaps it.
      await jest.advanceTimersByTimeAsync(5000);
      expect(answers).toHaveLength(1);
      answers[0]!();
      await jest.advanceTimersByTimeAsync(999);
      expect(answers).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(answers).toHaveLength(2);
      limits.disarm();
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
    expect(heapCapMb(env(undefined))).toBe(
      DEFAULT_RSS_LIMIT_MB * HEAP_CAP_OVER_RSS,
    );
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
        "/s/heap-not-a-breach.heapsnapshot",
      ]),
    ).toEqual([
      {
        identity: "2026-04-03T00-00-00-000Z-9",
        process: { kind: "host" },
        artifacts: {
          heapSnapshot: "/s/heap-2026-04-03T00-00-00-000Z-9.heapsnapshot",
        },
      },
      {
        identity: "2026-04-02T00-00-00-000Z-9",
        process: { kind: "host" },
        artifacts: {
          memoryReport: "/s/memory-2026-04-02T00-00-00-000Z-9.txt",
          heapSnapshot: "/s/heap-2026-04-02T00-00-00-000Z-9.heapsnapshot",
        },
      },
      {
        identity: "2026-04-01T00-00-00-000Z-9",
        process: { kind: "host" },
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

  test("a renderer's breach is listed as that renderer's", () => {
    expect(
      postMortemsOf([
        "/s/memory-2026-04-02T00-00-00-000Z-renderer-worktree-9.txt",
        "/s/heap-2026-04-02T00-00-00-000Z-renderer-worktree-9.heapsnapshot",
        "/s/heap-2026-04-01T00-00-00-000Z-8.heapsnapshot",
      ]),
    ).toEqual([
      {
        identity: "2026-04-02T00-00-00-000Z-renderer-worktree-9",
        process: { kind: "renderer", name: WORKTREE },
        artifacts: {
          memoryReport:
            "/s/memory-2026-04-02T00-00-00-000Z-renderer-worktree-9.txt",
          heapSnapshot:
            "/s/heap-2026-04-02T00-00-00-000Z-renderer-worktree-9.heapsnapshot",
        },
      },
      {
        identity: "2026-04-01T00-00-00-000Z-8",
        process: { kind: "host" },
        artifacts: {
          heapSnapshot: "/s/heap-2026-04-01T00-00-00-000Z-8.heapsnapshot",
        },
      },
    ]);
  });

  test("rotation keeps the newest breaches of each process, so one renderer's breaches never evict another's", async () => {
    const rec = newRec();
    rec.existingFiles = [
      "/d/memory-2026-01-01T00-00-00-000Z-host-1.txt",
      "/d/memory-2026-01-02T00-00-00-000Z-renderer-main-9.txt",
      "/d/memory-2026-01-03T00-00-00-000Z-renderer-worktree-8.txt",
      "/d/heap-2026-01-03T00-00-00-000Z-renderer-worktree-8.heapsnapshot",
    ];
    rec.renderers = [rendererAt(WORKTREE, 4444, 250 * MB)];
    await makeLimits(
      makeDeps(rec, { limitBytes: 200 * MB, snapshotsKeep: 1 }),
    ).check();
    expect([...rec.removed].sort()).toEqual([
      "/d/heap-2026-01-03T00-00-00-000Z-renderer-worktree-8.heapsnapshot",
      "/d/memory-2026-01-03T00-00-00-000Z-renderer-worktree-8.txt",
    ]);
  });

  test("a host breach an earlier build wrote, its renderer's heap beside it, is listed and rotated whole", async () => {
    const earlier = [
      "/d/memory-2026-01-01T00-00-00-000Z-7.txt",
      "/d/heap-2026-01-01T00-00-00-000Z-7.heapsnapshot",
      "/d/renderer-heap-2026-01-01T00-00-00-000Z-7.heapsnapshot",
    ];
    expect(postMortemsOf(earlier)).toEqual([
      {
        identity: "2026-01-01T00-00-00-000Z-7",
        process: { kind: "host" },
        artifacts: {
          memoryReport: earlier[0],
          heapSnapshot: earlier[1],
          rendererHeapSnapshot: earlier[2],
        },
      },
    ]);
    const rec = newRec();
    rec.fakeRss = 250 * MB;
    rec.existingFiles = [...earlier];
    await makeLimits(
      makeDeps(rec, { limitBytes: 200 * MB, snapshotsKeep: 1 }),
    ).check();
    expect([...rec.removed].sort()).toEqual([...earlier].sort());
  });

  test("a name no breach could have written is no post-mortem, and rotation goes on past it", async () => {
    const rec = newRec();
    rec.fakeRss = 250 * MB;
    rec.existingFiles = [
      // `a-` is no renderer's name.
      "/d/memory-2026-01-01T00-00-00-000Z-renderer-a--7.txt",
      "/d/memory-2026-01-01T00-00-00-000Z-gremlin-7.txt",
      "/d/memory-2026-01-02T00-00-00-000Z-host-6.txt",
    ];
    await makeLimits(
      makeDeps(rec, { limitBytes: 200 * MB, snapshotsKeep: 1 }),
    ).check();
    expect(rec.removed).toEqual([
      "/d/memory-2026-01-02T00-00-00-000Z-host-6.txt",
    ]);
    expect(rec.logs).not.toContainEqual(
      expect.objectContaining({
        msg: expect.stringContaining("rotation failed"),
      }),
    );
  });

  test("the breaches a state directory keeps are listed by breach; one that cannot be listed is a failure naming why, never no breaches", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-"));
    try {
      expect(listPostMortems(path.join(root, "absent"))).toEqual({
        kind: "ok",
        value: [],
      });
      const dir = path.join(root, "state");
      fs.mkdirSync(dir);
      const report = path.join(dir, "memory-2026-03-01T00-00-00-000Z-7.txt");
      fs.writeFileSync(report, "");
      expect(listPostMortems(dir)).toEqual({
        kind: "ok",
        value: [
          {
            identity: "2026-03-01T00-00-00-000Z-7",
            process: { kind: "host" },
            artifacts: { memoryReport: report },
          },
        ],
      });
      fs.writeFileSync(path.join(root, "file"), "");
      const unlisted = listPostMortems(path.join(root, "file"));
      expect(unlisted.kind).toBe("failed");
      expect(unlisted.kind === "failed" && unlisted.reason).toMatch(/ENOTDIR/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the real lister: a directory not yet made holds none; one that is a file is said so", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-"));
    try {
      expect(
        realLimitsDeps(0, () => {}, {
          launcher: unscriptedLauncher,
          log: () => {},
          clock: systemTimekeeper,
          snapshotDir: path.join(root, "absent"),
          writeLogNow: () => {},
        }).listArtifacts(),
      ).toEqual([]);
      fs.writeFileSync(path.join(root, "file"), "");
      expect(() =>
        realLimitsDeps(0, () => {}, {
          launcher: unscriptedLauncher,
          log: () => {},
          clock: systemTimekeeper,
          snapshotDir: path.join(root, "file"),
          writeLogNow: () => {},
        }).listArtifacts(),
      ).toThrow(/ENOTDIR/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// [LAW:no-ambient-temporal-coupling] A reading out when the daemon closes lands
// on a daemon that is gone.
describe("a breach landing after disarm", () => {
  test("writes nothing, asks for no exit and ends no renderer", async () => {
    const rec = newRec();
    rec.fakeRss = 10_000;
    rec.renderers = [rendererAt(MAIN_RENDERER, 4343, 10_000)];
    let answer!: () => void;
    const charged = makeDeps(rec).memoryCharge;
    const limits = makeLimits(
      makeDeps(rec, {
        limitBytes: 100,
        memoryCharge: (processes) =>
          new Promise(
            (resolve) => (answer = () => resolve(charged(processes))),
          ),
      }),
    );
    limits.arm();
    limits.disarm();
    answer();
    await limits.check();

    expect(rec.reportsWritten).toEqual([]);
    expect(rec.snapshotsWritten).toEqual([]);
    expect(rec.shutdownCalls).toEqual([]);
    expect(rec.ended).toEqual([]);
  });
});
