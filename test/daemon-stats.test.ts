import { RuntimeStats } from "../src/daemon/stats";
import { EMPTY_STORES } from "./helpers/doctor-facts";
import {
  formatStats,
  missingFields,
  shapeSkew,
} from "../src/daemon/client-stats";
import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// package.json is the version's sole authority; the tests read it the same way
// the build does rather than restating the number.
const pkg = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
) as { version: string };

describe("RuntimeStats.snapshot", () => {
  test("produces a stable shape with extras merged in", () => {
    const stats = new RuntimeStats();
    stats.requestsTotal = 10;
    stats.requestsErrored = 1;
    stats.requestsTimedOut = 2;
    stats.inFlight = 1;
    stats.watchersOpened = 5;
    stats.watchersClosed = 3;

    const snap = stats.snapshot({
      gitCache: {
        size: 4,
        hits: 100,
        misses: 20,
        invalidations: 3,
        watchers: 2,
      },
      usageCache: { size: 10, hits: 50, misses: 5, sweeps: 1 },
      transcriptReads: { reads: 0, bytes: 0, longLines: 0, largestLine: 0 },
      renderCache: {
        size: 3,
        held: 1,
        retired: 0,
        compiles: 1,
        accountedBytes: 3,
        budgetBytes: 9,
      },
      effectCache: { sessions: 2, effects: 5 },
      sessionState: { sessions: 2, observers: 11, revision: 7 },
      frameFeeds: { feeds: 0, subscribers: 0, drawn: 0, pushed: 0, refused: 0, lookups: 0, found: 0 },
      tmuxStatus: { sessions: 0, layouts: 0, writes: 0, failedWrites: 0 },
      watchersActive: 2,
      handlerProbes: [{ nonce: "n", handler: "1.2.3" }],
      clients: [
        {
          client: null,
          sessionId: "s1",
          termCols: 148,
          rateLimits: "carried",
          claudeConfigDir: "/c",
          projectDir: "/p",
          transcript: { path: "/c/t.jsonl", answered: true },
          frame: "still",
          role: "statusline",
          ago: 4,
          since: 30,
          redrawn: [4, 5],
        },
      ],
      bundle: "/opt/cc/dist/index.mjs",
      daemon: { pid: 1234, memory: { kind: "unmeasured" }, limit: 1, postMortems: { kind: "ok", value: [] } },
      doctorStores: EMPTY_STORES,
    });
    expect(snap.handlerProbes).toEqual([{ nonce: "n", handler: "1.2.3" }]);
    expect(snap.clients).toEqual([
      {
          client: null,
          sessionId: "s1",
          termCols: 148,
          rateLimits: "carried",
          claudeConfigDir: "/c",
          projectDir: "/p",
          transcript: { path: "/c/t.jsonl", answered: true },
          frame: "still",
          role: "statusline",
          ago: 4,
          since: 30,
          redrawn: [4, 5],
        },
    ]);
    expect(snap.bundle).toBe("/opt/cc/dist/index.mjs");
    expect(snap.doctorStores).toEqual(EMPTY_STORES);

    expect(snap.requests).toEqual({
      total: 10,
      errored: 1,
      timedOut: 2,
      inFlight: 1,
    });
    expect(snap.gitCache.hits).toBe(100);
    expect(snap.usageCache.size).toBe(10);
    expect(snap.effectCache).toEqual({ sessions: 2, effects: 5 });
    expect(snap.sessionState).toEqual({ sessions: 2, observers: 11, revision: 7 });
    expect(snap.watchers).toEqual({
      active: 2,
      opened: 5,
      closed: 3,
    });
    expect(snap.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(snap.pid).toBe(process.pid);
    expect(snap.rssBytes).toBeGreaterThan(0);
  });

  // [LAW:one-source-of-truth] The snapshot's `version` is the daemon's package
  // stamp (what `cc-candybar --version` prints for the same build), and the
  // wire contract number lives under its own name — two facts, two fields.
  test("version is the package stamp; protocolVersion is the wire contract", () => {
    const snap = RuntimeStats.referenceSnapshot();
    expect(snap.version).toBe(pkg.version);
    expect(snap.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe("shapeSkew", () => {
  test("a snapshot from this build is none", () => {
    expect(shapeSkew(RuntimeStats.referenceSnapshot())).toBeNull();
  });

  test("a snapshot of another digest with every field is none: shape, not identity", () => {
    const snap = RuntimeStats.referenceSnapshot();
    expect(shapeSkew({ ...snap, sourceDigest: "abcdef0123456789" })).toBeNull();
    expect(shapeSkew({ ...snap, version: "0.0.1" })).toBeNull();
  });

  test("a snapshot lacking fields this build reads names them and both builds", () => {
    const snap = RuntimeStats.referenceSnapshot();
    const { sessionState: _s, sourceDigest: _d, ...older } = snap;
    const skew = shapeSkew(older as typeof snap);
    expect(skew).toContain("reports no sourceDigest, sessionState");
    expect(skew).toContain(`the daemon (${pkg.version} [no digest])`);
    expect(skew).toContain(`this client (${pkg.version} [`);
  });

  test("a reader is refused only for the fields it reads", () => {
    const snap = RuntimeStats.referenceSnapshot();
    const { clients: _c, ...older } = snap;
    expect(shapeSkew(older as typeof snap, ["handlerProbes"])).toBeNull();
    expect(shapeSkew(older as typeof snap, ["bundle", "clients"])).toContain(
      "reports no clients;",
    );
  });

  test("missingFields names a nested field by its path, and an atom in place of an object", () => {
    const snap = RuntimeStats.referenceSnapshot();
    const { observers: _o, ...sessionState } = snap.sessionState;
    expect(missingFields(snap, { ...snap, sessionState })).toEqual([
      "sessionState.observers",
    ]);
    expect(missingFields(snap, { ...snap, watchers: 3 })).toEqual(["watchers"]);
    // A list the reader maps, carried as anything else, is as absent to it.
    expect(
      missingFields(snap, { ...snap, clients: null, handlerProbes: {} }),
    ).toEqual(["handlerProbes", "clients"]);
    expect(missingFields(snap, snap)).toEqual([]);
    // A union's arms differ: the reference's `ok` arm is no spec of a
    // `failed` one, so a tagged union is judged present, not below its tag.
    const unlisted = {
      ...snap,
      daemon: { ...snap.daemon, postMortems: { kind: "failed", reason: "EACCES" } },
    };
    expect(missingFields(snap, unlisted)).toEqual([]);
    expect(
      missingFields(snap, { ...snap, daemon: { ...snap.daemon, postMortems: 3 } }),
    ).toEqual(["daemon.postMortems"]);
  });
});

describe("formatStats", () => {
  test("renders human-readable output with hit rates", () => {
    const out = formatStats({
      pid: 1234,
      version: "1.41.2",
      sourceDigest: null,
      protocolVersion: 2,
      startedAt: "2026-04-28T00:00:00.000Z",
      uptimeSec: 125,
      rssBytes: 50 * 1024 * 1024,
      heapUsedBytes: 20 * 1024 * 1024,
      heapTotalBytes: 30 * 1024 * 1024,
      externalBytes: 1 * 1024 * 1024,
      arrayBuffersBytes: 256 * 1024,
      requests: { total: 100, errored: 2, timedOut: 1, inFlight: 0 },
      gitCache: {
        size: 5,
        hits: 80,
        misses: 20,
        invalidations: 3,
        watchers: 5,
      },
      usageCache: { size: 3, hits: 40, misses: 10, sweeps: 0 },
      transcriptReads: { reads: 0, bytes: 0, longLines: 0, largestLine: 0 },
      renderCache: {
        size: 4,
        held: 0,
        retired: 1,
        compiles: 2,
        accountedBytes: 32 * 1024 * 1024,
        budgetBytes: 128 * 1024 * 1024,
      },
      effectCache: { sessions: 2, effects: 3 },
      sessionState: { sessions: 2, observers: 11, revision: 7 },
      frameFeeds: { feeds: 0, subscribers: 0, drawn: 0, pushed: 0, refused: 0, lookups: 0, found: 0 },
      tmuxStatus: { sessions: 0, layouts: 0, writes: 0, failedWrites: 0 },
      watchers: { active: 5, opened: 7, closed: 2 },
      subprocesses: {
        total: 0,
        inFlight: 0,
        lastMinute: 0,
        byCategory: {},
        p50DurationMs: {},
        p99DurationMs: {},
      },
      nextRestartReason: null,
      handlerProbes: [],
      clients: [],
      bundle: "/",
      daemon: { pid: 1234, memory: { kind: "unmeasured" }, limit: 1, postMortems: { kind: "ok", value: [] } },
      doctorStores: EMPTY_STORES,
    });
    expect(out).toContain("pid           1234");
    expect(out).toContain("uptime        2m5s");
    expect(out).toContain("rss           50.0MB");
    expect(out).toContain("hit rate      80.0%");
    expect(out).toContain("active        5");
    expect(out).toContain("effects       3");
    expect(out).toContain("observers     11");
    expect(out).toContain("revision      7");
    expect(out).toContain("compiles      2");
    expect(out).toContain("accounted     32.0MB / 128.0MB");
  });

  test("hit rate is n/a when no observations", () => {
    const out = formatStats({
      pid: 1,
      version: "1.41.2",
      sourceDigest: null,
      protocolVersion: 2,
      startedAt: "2026-04-28T00:00:00.000Z",
      uptimeSec: 0,
      rssBytes: 100,
      heapUsedBytes: 50,
      heapTotalBytes: 100,
      externalBytes: 0,
      arrayBuffersBytes: 0,
      requests: { total: 0, errored: 0, timedOut: 0, inFlight: 0 },
      gitCache: { size: 0, hits: 0, misses: 0, invalidations: 0, watchers: 0 },
      usageCache: { size: 0, hits: 0, misses: 0, sweeps: 0 },
      transcriptReads: { reads: 0, bytes: 0, longLines: 0, largestLine: 0 },
      renderCache: {
        size: 0,
        held: 0,
        retired: 0,
        compiles: 0,
        accountedBytes: 0,
        budgetBytes: 0,
      },
      effectCache: { sessions: 0, effects: 0 },
      sessionState: { sessions: 0, observers: 0, revision: 0 },
      frameFeeds: { feeds: 0, subscribers: 0, drawn: 0, pushed: 0, refused: 0, lookups: 0, found: 0 },
      tmuxStatus: { sessions: 0, layouts: 0, writes: 0, failedWrites: 0 },
      watchers: { active: 0, opened: 0, closed: 0 },
      subprocesses: {
        total: 0,
        inFlight: 0,
        lastMinute: 0,
        byCategory: {},
        p50DurationMs: {},
        p99DurationMs: {},
      },
      nextRestartReason: null,
      handlerProbes: [],
      clients: [],
      bundle: "/",
      daemon: { pid: 1234, memory: { kind: "unmeasured" }, limit: 1, postMortems: { kind: "ok", value: [] } },
      doctorStores: EMPTY_STORES,
    });
    expect(out).toContain("hit rate      n/a");
  });
});
