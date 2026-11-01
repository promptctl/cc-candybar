import { RuntimeStats, type SourceSnapshots } from "../src/daemon/stats";
import { EMPTY_STORES } from "./helpers/doctor-facts";
import {
  formatStats,
  missingFields,
  shapeSkew,
  statsPlan,
} from "../src/daemon/client-stats";
import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// package.json is the version's sole authority; the tests read it the same way
// the build does rather than restating the number.
const pkg = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
) as { version: string };

// Every source's record as the ledger keeps it, and the homes by scope.
const SOURCES: SourceSnapshots = {
  records: [
    {
      name: "tmux",
      scope: "pane",
      refreshes: { first: 2, period: 7, change: 0, supersede: 0 },
      failures: 1,
      lastMs: 3,
    },
    {
      name: "cache",
      scope: "session",
      refreshes: { request: 3 },
      failures: 1,
      lastMs: 0,
    },
  ],
  homes: {
    daemon: 1,
    configDir: 1,
    repo: 4,
    directory: 3,
    session: 10,
    view: 2,
    pane: 2,
  },
  held: { git: 1, tmux: 1, host: 2, today: 1, pluginStorage: 1 },
  pluginStorage: {
    folders: 1,
    faults: { unusable: 0, refused: 1, error: 0 },
    lost: 1,
  },
};

// Stalled since a fixed instant, after one earlier stall and one catch-up.
const FILE_EVENTS = {
  delivery: {
    kind: "stalled",
    missedSince: Date.parse("2026-10-27T04:00:00.000Z"),
  },
  stalls: 2,
  catchUps: 1,
  probes: 7,
  probeFailures: 1,
} as const;

describe("RuntimeStats.snapshot", () => {
  test("produces a stable shape with extras merged in", () => {
    const stats = new RuntimeStats();
    stats.requestsTotal = 10;
    stats.requestsErrored = 1;
    stats.requestsTimedOut = 2;
    stats.inFlight = 1;
    stats.watchersOpened = 5;
    stats.watchersClosed = 3;
    stats.watchRefusals = 1;
    stats.watchErrors = 2;
    stats.dirWatchesOpened = 9;
    stats.dirWatchesClosed = 4;

    const snap = stats.snapshot({
      sourceDigest: null,
      gitCache: {
        size: 4,
        held: 1,
        hits: 100,
        misses: 20,
        changes: 3,
        watchers: 2,
      },
      usageCache: { size: 10, hits: 50, misses: 5, sweeps: 1 },
      sources: SOURCES,
      fileEvents: FILE_EVENTS,
      transcriptReads: { reads: 0, bytes: 0, longLines: 0, largestLine: 0 },
      renderCache: {
        size: 3,
        held: 1,
        retired: 0,
        compiles: 1,
        views: 0,
        pinned: 0,
        retiredViews: 0,
        accountedBytes: 3,
        budgetBytes: 9,
      },
      effectCache: { sessions: 2, effects: 5 },
      menuIdle: { sessions: 2, armed: 1 },
      journalTurns: { holder: null, heldMs: 0, queued: 0 },
      runs: { started: 3, failed: 1, timedOut: 1, refused: 2, running: 0 },
      sessionState: { sessions: 2, observers: 11, revision: 7 },
      frameFeeds: {
        feeds: 0,
        subscribers: 0,
        drawn: 0,
        pushed: 0,
        refused: 0,
        lookups: 0,
        found: 0,
      },
      tmuxStatus: { sessions: 0, layouts: 0, writes: 0, failedWrites: 0 },
      watchersActive: 2,
      dirWatchesActive: 5,
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
        },
      ],
      bundle: "/opt/cc/dist/index.mjs",
      daemon: {
        pid: 1234,
        memory: { kind: "unmeasured" },
        limit: 1,
        postMortems: { kind: "ok", value: [] },
      },
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
    expect(snap.gitCache.held).toBe(1);
    expect(snap.usageCache.size).toBe(10);
    expect(snap.sources).toEqual(SOURCES);
    expect(snap.effectCache).toEqual({ sessions: 2, effects: 5 });
    expect(snap.menuIdle).toEqual({ sessions: 2, armed: 1 });
    expect(snap.runs).toEqual({
      started: 3,
      failed: 1,
      timedOut: 1,
      refused: 2,
      running: 0,
    });
    expect(snap.sessionState).toEqual({
      sessions: 2,
      observers: 11,
      revision: 7,
    });
    expect(snap.watchers).toEqual({
      active: 2,
      opened: 5,
      closed: 3,
      refused: 1,
      errors: 2,
      dirs: { active: 5, opened: 9, closed: 4 },
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
      daemon: {
        ...snap.daemon,
        postMortems: { kind: "failed", reason: "EACCES" },
      },
    };
    expect(missingFields(snap, unlisted)).toEqual([]);
    expect(
      missingFields(snap, {
        ...snap,
        daemon: { ...snap.daemon, postMortems: 3 },
      }),
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
      unknownHookFields: ["fast_mode", "x\n  inFlight      9"],
      gitCache: {
        size: 5,
        held: 2,
        hits: 80,
        misses: 20,
        changes: 3,
        watchers: 5,
      },
      usageCache: { size: 3, hits: 40, misses: 10, sweeps: 0 },
      sources: SOURCES,
      fileEvents: FILE_EVENTS,
      transcriptReads: { reads: 0, bytes: 0, longLines: 0, largestLine: 0 },
      renderCache: {
        size: 4,
        held: 0,
        retired: 1,
        compiles: 2,
        views: 0,
        pinned: 0,
        retiredViews: 0,
        accountedBytes: 32 * 1024 * 1024,
        budgetBytes: 128 * 1024 * 1024,
      },
      effectCache: { sessions: 2, effects: 3 },
      menuIdle: { sessions: 2, armed: 1 },
      journalTurns: { holder: null, heldMs: 0, queued: 0 },
      runs: { started: 3, failed: 1, timedOut: 1, refused: 2, running: 0 },
      sessionState: { sessions: 2, observers: 11, revision: 7 },
      frameFeeds: {
        feeds: 0,
        subscribers: 0,
        drawn: 0,
        pushed: 0,
        refused: 0,
        lookups: 0,
        found: 0,
      },
      tmuxStatus: { sessions: 0, layouts: 0, writes: 0, failedWrites: 0 },
      watchers: {
        active: 5,
        opened: 7,
        closed: 2,
        refused: 1,
        errors: 3,
        dirs: { active: 4, opened: 6, closed: 2 },
      },
      subprocesses: {
        total: 0,
        inFlight: 0,
        lastMinute: 0,
        byCategory: {},
        refused: {},
        p50DurationMs: {},
        p99DurationMs: {},
      },
      nextRestartReason: null,
      handlerProbes: [],
      clients: [],
      bundle: "/",
      daemon: {
        pid: 1234,
        memory: { kind: "unmeasured" },
        limit: 1,
        postMortems: { kind: "ok", value: [] },
      },
      doctorStores: EMPTY_STORES,
    });
    expect(out).toContain("pid           1234");
    // A name a client chose cannot forge a row: each is a JSON string.
    expect(out).toContain('unknownFields "fast_mode", "x\\n  inFlight      9"');
    expect(out).not.toContain("\n  inFlight      9");
    expect(out).toContain("uptime        2m5s");
    expect(out).toContain("rss           50.0MB");
    expect(out).toContain("held          2");
    expect(out).toContain("hit rate      80.0%");
    expect(out).toContain(
      "pane/tmux                 failures=1 last=3ms refreshes first:2 period:7 change:0 supersede:0",
    );
    expect(out).toContain(
      "session/cache             failures=1 last=0ms refreshes request:3",
    );
    expect(out).toContain(
      "homes         daemon:1 configDir:1 repo:4 directory:3 session:10 view:2 pane:2",
    );
    expect(out).toContain(
      "held          git:1 tmux:1 host:2 today:1 pluginStorage:1",
    );
    expect(out).toContain(
      "plugin storage folders=1 lost=1 faults unusable:0 refused:1 error:0",
    );
    expect(out).toContain(
      "fileEvents    stalled unvouched since 2026-10-27T04:00:00.000Z stalls=2 catchUps=1 probes=7 probeFailures=1",
    );
    expect(out).toContain("refused       1");
    expect(out).toContain("errors        3");
    expect(out).toContain("active        5");
    expect(out).toContain("effects       3");
    expect(out).toContain("armed         1");
    expect(out).toContain("observers     11");
    expect(out).toContain("revision      7");
    expect(out).toContain("compiles      2");
    expect(out).toContain("accounted     32.0MB / 128.0MB");
  });

  test("a refused row sits in the column the rows above it use", () => {
    const snap = RuntimeStats.referenceSnapshot();
    const out = formatStats({
      ...snap,
      subprocesses: {
        ...snap.subprocesses,
        byCategory: { git: 1 },
        p50DurationMs: {},
        p99DurationMs: {},
        refused: { "click.pbcopy": 3 },
      },
    });

    const width = "click.pbcopy refused".length;
    expect(out).toContain(`  ${"git".padEnd(width)} 1\n`);
    expect(out).toContain(`  ${"click.pbcopy refused".padEnd(width)} 3\n`);
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
      unknownHookFields: [],
      gitCache: {
        size: 0,
        held: 0,
        hits: 0,
        misses: 0,
        changes: 0,
        watchers: 0,
      },
      usageCache: { size: 0, hits: 0, misses: 0, sweeps: 0 },
      sources: RuntimeStats.referenceSnapshot().sources,
      fileEvents: RuntimeStats.referenceSnapshot().fileEvents,
      transcriptReads: { reads: 0, bytes: 0, longLines: 0, largestLine: 0 },
      renderCache: {
        size: 0,
        held: 0,
        retired: 0,
        compiles: 0,
        views: 0,
        pinned: 0,
        retiredViews: 0,
        accountedBytes: 0,
        budgetBytes: 0,
      },
      effectCache: { sessions: 0, effects: 0 },
      menuIdle: { sessions: 0, armed: 0 },
  journalTurns: { holder: null, heldMs: 0, queued: 0 },
      runs: { started: 0, failed: 0, timedOut: 0, refused: 0, running: 0 },
      sessionState: { sessions: 0, observers: 0, revision: 0 },
      frameFeeds: {
        feeds: 0,
        subscribers: 0,
        drawn: 0,
        pushed: 0,
        refused: 0,
        lookups: 0,
        found: 0,
      },
      tmuxStatus: { sessions: 0, layouts: 0, writes: 0, failedWrites: 0 },
      watchers: {
        active: 0,
        opened: 0,
        closed: 0,
        refused: 0,
        errors: 0,
        dirs: { active: 0, opened: 0, closed: 0 },
      },
      subprocesses: {
        total: 0,
        inFlight: 0,
        lastMinute: 0,
        byCategory: {},
        refused: {},
        p50DurationMs: {},
        p99DurationMs: {},
      },
      nextRestartReason: null,
      handlerProbes: [],
      clients: [],
      bundle: "/",
      daemon: {
        pid: 1234,
        memory: { kind: "unmeasured" },
        limit: 1,
        postMortems: { kind: "ok", value: [] },
      },
      doctorStores: EMPTY_STORES,
    });
    expect(out).toContain("hit rate      n/a");
  });
});

// [LAW:verifiable-goals] The text/exit-code contract of `daemon-stats` is a
// plan value (src/cli-plan.ts delivers it), so it is pinned here without a
// process.
describe("statsPlan — the text/exit-code contract", () => {
  const snap = RuntimeStats.referenceSnapshot();

  it("JSON mode carries the whole snapshot on stdout and exits 0", () => {
    const plan = statsPlan({ kind: "ok", value: snap }, true);
    expect(plan.code).toBe(0);
    expect(plan.stderr).toBe("");
    expect(JSON.parse(plan.stdout)).toEqual(JSON.parse(JSON.stringify(snap)));
  });

  it("text mode carries the formatted report", () => {
    const plan = statsPlan({ kind: "ok", value: snap }, false);
    expect(plan).toEqual({ stdout: formatStats(snap), stderr: "", code: 0 });
  });

  it("a skewed daemon's JSON is still delivered, beside the skew and a failing code", () => {
    const { clients: _clients, ...older } = snap;
    const plan = statsPlan({ kind: "ok", value: older as typeof snap }, true);
    expect(plan.code).toBe(1);
    expect(plan.stderr).toMatch(/^daemon-stats: .*reports no clients/);
    expect(JSON.parse(plan.stdout)).not.toHaveProperty("clients");
  });

  it("an unreachable daemon is a stderr line and exit 1, nothing on stdout", () => {
    const plan = statsPlan(
      {
        kind: "transient",
        cause: "unreachable",
        message: "ECONNREFUSED",
      },
      false,
    );
    expect(plan.stdout).toBe("");
    expect(plan.stderr).toMatch(/^daemon-stats: daemon unavailable/);
    expect(plan.code).toBe(1);
  });
});
