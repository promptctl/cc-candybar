import { RuntimeStats } from "../src/daemon/stats";
import type {
  Durations,
  SourceSnapshots,
} from "../src/daemon/foundations/stats-snapshot";
import { EMPTY_RENDERER_STATS, emptyStats } from "./helpers/empty-stats";
import {
  MAIN_RENDERER,
  rendererNameOf,
} from "../src/daemon/foundations/renderer-name";

// No durations recorded: every reading zero, never NaN.
const NO_DURATIONS: Durations = {
  count: 0,
  p50Ms: 0,
  p90Ms: 0,
  p99Ms: 0,
  p999Ms: 0,
  maxMs: 0,
  meanMs: 0,
  stddevMs: 0,
};
import {
  formatStats,
  statsReplyOf,
  statsPlan,
} from "../src/daemon/client-stats";
import { PROTOCOL_VERSION } from "../src/daemon/foundations/protocol";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { systemTimekeeper } from "../scripts/lib/system-clock";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { BYTES_PER_MB as MB } from "../src/daemon/foundations/memory-limit";

const S1 = sessionIdOf("s1");

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
      abandoned: 0,
      lastMs: 3,
    },
    {
      name: "cache",
      scope: "session",
      refreshes: { first: 1, period: 0, change: 2 },
      failures: 1,
      abandoned: 0,
      lastMs: 0,
    },
  ],
  homes: {
    daemon: 1,
    configDir: 1,
    repo: 4,
    session: 10,
    pane: 2,
  },
  held: {
    git: 1,
    tmux: 1,
    host: 2,
    today: 1,
    pluginStorage: 1,
    transcript: 3,
  },
  pluginStorage: {
    folders: 1,
    faults: { unusable: 0, unreadable: 0, refused: 1, error: 0 },
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

// The declared sources' runs: a shell entry held by two homes, one read
// abandoned; no file run yet; one path watched.
const SOURCE_RUNS = {
  shell: {
    entries: 1,
    held: 1,
    refreshes: { first: 1, period: 4, change: 0, supersede: 0 },
    failures: 1,
    abandoned: 1,
    lastMs: 12,
  },
  file: {
    entries: 0,
    held: 0,
    refreshes: { first: 0, period: 0, change: 0, supersede: 0 },
    failures: 0,
    abandoned: 0,
    lastMs: null,
  },
  watches: 1,
} as const;

// What the daemon's parts report beside the counters RuntimeStats owns.
const EXTRAS: Parameters<RuntimeStats["snapshot"]>[0] = {
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
  sourceRuns: SOURCE_RUNS,
  transcriptReads: { reads: 0, bytes: 0, longLines: 0, largestLine: 0 },
  collector: { sessions: 1, retiring: 0 },
  runs: { started: 3, failed: 1, timedOut: 1, refused: 0, running: 0 },
  frameFeeds: {
    feeds: 0,
    subscribers: 0,
    pushed: 0,
    refused: 0,
    lookups: 0,
    found: 0,
  },
  watchersActive: 2,
  dirWatchesActive: 5,
  polledPaths: 7,
  clients: [
    {
      client: null,
      sessionId: S1,
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
  host: { pid: 1234, memory: { kind: "unmeasured" }, limit: 1, nearAt: 0 },
  renderers: [
    {
      name: MAIN_RENDERER,
      process: { kind: "in-host" },
      mailbox: { holder: null, heldMs: 0, queued: 0 },
      stats: {
        kind: "ok",
        value: {
          ...EMPTY_RENDERER_STATS,
          effectCache: { sessions: 2, effects: 5 },
          sessionState: { sessions: 2, observers: 11, revision: 7 },
        },
      },
    },
  ],
};

describe("RuntimeStats.snapshot", () => {
  test("produces a stable shape with extras merged in", () => {
    const stats = new RuntimeStats(systemTimekeeper);
    stats.requestsTotal = 10;
    stats.environmentMisses = 3;
    stats.requestsErrored = 1;
    stats.requestsTimedOut = 2;
    stats.inFlight = 1;
    stats.watchersOpened = 5;
    stats.watchersClosed = 3;
    stats.watchRefusals = 1;
    stats.watchErrors = 2;
    stats.dirWatchesOpened = 9;
    stats.dirWatchesClosed = 4;

    const snap = stats.snapshot(EXTRAS);
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

    expect(snap.requests).toEqual({
      total: 10,
      environmentMisses: 3,
      errored: 1,
      timedOut: 2,
      inFlight: 1,
      took: NO_DURATIONS,
    });
    expect(snap.gitCache.hits).toBe(100);
    expect(snap.gitCache.held).toBe(1);
    expect(snap.usageCache.size).toBe(10);
    expect(snap.sources).toEqual(SOURCES);
    expect(snap.host).toEqual(EXTRAS.host);
    expect(snap.renderers).toEqual(EXTRAS.renderers);
    expect(snap.runs).toEqual({
      started: 3,
      failed: 1,
      timedOut: 1,
      refused: 0,
      running: 0,
    });
    expect(snap.watchers).toEqual({
      active: 2,
      opened: 5,
      closed: 3,
      refused: 1,
      errors: 2,
      dirs: { active: 5, opened: 9, closed: 4 },
      polled: 7,
    });
    expect(snap.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(snap.pid).toBe(process.pid);
    expect(snap.rssBytes).toBeGreaterThan(0);
  });

  // [LAW:one-source-of-truth] The snapshot's `version` is the daemon's package
  // stamp (what `cc-candybar --version` prints for the same build), and the
  // wire contract number lives under its own name — two facts, two fields.
  test("version is the package stamp; protocolVersion is the wire contract", () => {
    const snap = emptyStats();
    expect(snap.version).toBe(pkg.version);
    expect(snap.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  // A percentile over every duration recorded, never a sample of them: with a
  // thousand renders, the slowest twenty hold the p99 and the slowest one the
  // max.
  test("render and launch durations are reported as percentiles of every one recorded", () => {
    const stats = new RuntimeStats(systemTimekeeper);
    for (let i = 0; i < 980; i++) stats.recordTook(2);
    for (let i = 0; i < 19; i++) stats.recordTook(40);
    stats.recordTook(500);
    for (let i = 0; i < 100; i++) {
      stats.launchStats.onStart("git");
      stats.launchStats.onEnd("git", 19);
    }
    const { requests, subprocesses } = stats.snapshot(EXTRAS);
    expect(requests.took).toMatchObject({
      count: 1000,
      p50Ms: 2,
      p90Ms: 2,
      maxMs: 500,
      meanMs: 3.22,
    });
    // To the histogram's three significant digits: 40 ms lies in a bucket
    // whose highest value is 40.03.
    expect(requests.took.p99Ms).toBeCloseTo(40, 1);
    expect(requests.took.p999Ms).toBeCloseTo(40, 1);
    expect(subprocesses.durations["git"]).toEqual({
      count: 100,
      p50Ms: 19,
      p90Ms: 19,
      p99Ms: 19,
      p999Ms: 19,
      maxMs: 19,
      meanMs: 19,
      stddevMs: 0,
    });
  });

  // A percentile reads the value its bucket stands for, never one rounded
  // below it: a frame 16.79 ms late does not read as inside a 16.7 ms period.
  test("a percentile reads no lower than the durations it stands for", () => {
    const stats = new RuntimeStats(systemTimekeeper);
    for (let i = 0; i < 100; i++) stats.recordTook(16.79);
    stats.recordTook(20);
    expect(stats.snapshot(EXTRAS).requests.took).toMatchObject({
      p99Ms: 16.8,
      maxMs: 20,
    });
  });

  // A value above where the histogram counts exactly falls in a bucket wider
  // than a millisecond, whose highest value lies above it; a percentile still
  // never reads above the largest value recorded.
  test("no percentile reads above the largest duration recorded", () => {
    const stats = new RuntimeStats(systemTimekeeper);
    for (let i = 0; i < 10; i++) {
      stats.launchStats.onStart("git");
      stats.launchStats.onEnd("git", 9999);
    }
    expect(stats.snapshot(EXTRAS).subprocesses.durations["git"]).toMatchObject({
      p50Ms: 9999,
      p99Ms: 9999,
      p999Ms: 9999,
      maxMs: 9999,
    });
  });
});

describe("a stats reply", () => {
  test("a snapshot from this build is ours", () => {
    const snap = emptyStats();
    expect(statsReplyOf(snap)).toEqual({ kind: "ours", snapshot: snap });
  });

  test("a snapshot of another digest with every field is ours: shape, not identity", () => {
    const snap = emptyStats();
    for (const other of [
      { ...snap, sourceDigest: "abcdef0123456789" },
      { ...snap, version: "0.0.1" },
    ])
      expect(statsReplyOf(other)).toEqual({ kind: "ours", snapshot: other });
  });

  test("a snapshot lacking fields this build reads is another build's, naming them and both builds", () => {
    const snap = emptyStats();
    const { renderers: _r, sourceDigest: _d, ...older } = snap;
    const reply = statsReplyOf(older);
    if (reply.kind !== "another-build") throw new Error("read as ours");
    expect(reply.said).toBe(older);
    expect(reply.skew).toContain("reports no sourceDigest, renderers");
    expect(reply.skew).toContain(`the daemon (${pkg.version} [no digest])`);
    expect(reply.skew).toContain(`this client (${pkg.version} [`);
  });

  test("a reply that is no snapshot at all is another build's, its build unsaid", () => {
    const reply = statsReplyOf(7);
    expect(reply).toMatchObject({ kind: "another-build", said: 7 });
    if (reply.kind !== "another-build") throw new Error("read as ours");
    expect(reply.skew).toMatch(
      /^the daemon \(no version \[no digest\]\) reports no <snapshot>;/,
    );
  });

  // Where a reply is not this build's, as the skew names it.
  const skewOf = (said: unknown): string[] => {
    const reply = statsReplyOf(said);
    if (reply.kind === "ours") return [];
    return /reports no (.*); it is another build/
      .exec(reply.skew)![1]!
      .split(", ");
  };
  const sizes = { rss: 1, heapTotal: 1 };
  const panel = (fields: object) => ({
    name: MAIN_RENDERER,
    process: { kind: "in-host" },
    mailbox: { holder: "render", heldMs: 3, queued: 1 },
    stats: { kind: "ok", value: EMPTY_RENDERER_STATS },
    ...fields,
  });

  test("the producer's snapshot is ours in every arm its parts report", () => {
    const stats = new RuntimeStats(systemTimekeeper);
    const memory = (reading: object) => ({
      pid: 9,
      memory: reading,
      limit: 512 * MB,
      nearAt: 384 * MB,
    });
    const snap = stats.snapshot({
      ...EXTRAS,
      sourceDigest: "abcdef",
      sources: {
        ...SOURCES,
        records: [
          {
            name: "git",
            scope: "repo",
            refreshes: { first: 1, change: 2 },
            failures: 0,
            abandoned: 0,
            lastMs: 4,
          },
        ],
      },
      fileEvents: {
        ...FILE_EVENTS,
        delivery: { kind: "unmeasured", since: 1, reason: "x", missedSince: 1 },
      },
      clients: [
        {
          ...EXTRAS.clients[0]!,
          client: { kind: "native", bundle: "/b", source: null },
          termCols: null,
        },
      ],
      host: memory({
        kind: "measured",
        charge: { kind: "charged", measure: "phys_footprint", bytes: 1 },
        usage: { kind: "read", sizes },
      }) as never,
      renderers: [
        panel({}),
        panel({
          process: { kind: "not-running", why: "it exited 1" },
          stats: { kind: "failed", reason: "not asked" },
        }),
        panel({
          process: {
            kind: "process",
            memory: memory({
              kind: "measured",
              charge: { kind: "stand-in", rss: 1, gap: 0, unread: "x" },
              usage: { kind: "unread", why: "no ping" },
            }),
          },
        }),
        panel({
          process: {
            kind: "process",
            memory: memory({
              kind: "measured",
              charge: { kind: "unread", gap: 0, unread: "x" },
              usage: { kind: "read", sizes },
            }),
          },
        }),
      ] as never,
    });
    expect(skewOf(snap)).toEqual([]);
    expect(
      skewOf({
        ...snap,
        fileEvents: {
          ...snap.fileEvents,
          delivery: { kind: "stalled", missedSince: 1 },
        },
      }),
    ).toEqual([]);
  });

  test("a field missing below the top, an atom in place of an object, and a list carried as anything else are each named by path", () => {
    const snap = emptyStats();
    const { retiring: _r, ...collector } = snap.collector;
    expect(skewOf({ ...snap, collector })).toEqual(["collector.retiring"]);
    expect(skewOf({ ...snap, watchers: 3 })).toEqual(["watchers"]);
    expect(skewOf({ ...snap, clients: null })).toEqual(["clients"]);
    expect(skewOf({ ...snap, host: { ...snap.host, memory: 3 } })).toEqual([
      "host.memory",
    ]);
  });

  test("an arm or a word this build does not know is another build's, named at its tag", () => {
    const snap = emptyStats();
    expect(
      skewOf({ ...snap, host: { ...snap.host, memory: { kind: "later" } } }),
    ).toEqual(["host.memory.kind"]);
    expect(
      skewOf({
        ...snap,
        renderers: [
          panel({ process: { kind: "later" } }),
          panel({ stats: { kind: "later", value: {} } }),
        ],
      }),
    ).toEqual(["renderers[0].process.kind", "renderers[1].stats.kind"]);
    expect(
      skewOf({
        ...snap,
        clients: [{ ...EXTRAS.clients[0]!, frame: "later" }],
      }),
    ).toEqual(["clients[0].frame"]);
  });

  test("a field of another type than this build's is another build's", () => {
    const snap = emptyStats();
    expect(skewOf({ ...snap, sourceDigest: {}, version: 7 })).toEqual([
      "version",
      "sourceDigest",
    ]);
    expect(
      skewOf({
        ...snap,
        renderers: [panel({ mailbox: { holder: 3, heldMs: 0, queued: 0 } })],
      }),
    ).toEqual(["renderers[0].mailbox.holder"]);
  });

  test("each arm is read below its tag, and each element of a list", () => {
    const snap = emptyStats();
    const measured = (memory: object) => ({
      ...snap,
      host: { ...snap.host, memory: { kind: "measured", ...memory } },
    });
    expect(skewOf(measured({ usage: { kind: "read", sizes } }))).toEqual([
      "host.memory.charge",
    ]);
    expect(
      skewOf(
        measured({
          charge: { kind: "stand-in", rss: 1, unread: "x" },
          usage: { kind: "read", sizes },
        }),
      ),
    ).toEqual(["host.memory.charge.gap"]);
    const { refreshes: _f, ...unrefreshed } = {
      name: "git",
      scope: "repo",
      refreshes: {},
      failures: 0,
      abandoned: 0,
      lastMs: null,
    };
    const { frame: _d, ...undrawn } = EXTRAS.clients[0]!;
    expect(
      skewOf({
        ...snap,
        sources: { ...snap.sources, records: [unrefreshed] },
        clients: [undrawn],
      }),
    ).toEqual(["sources.records[0].refreshes", "clients[0].frame"]);
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
      requests: {
        environmentMisses: 3,
        total: 100,
        errored: 2,
        timedOut: 1,
        inFlight: 0,
        took: {
          count: 100,
          p50Ms: 3.1,
          p90Ms: 5,
          p99Ms: 11.2,
          p999Ms: 161,
          maxMs: 161,
          meanMs: 4.2,
          stddevMs: 15.6,
        },
      },
      tasksThrew: 3,
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
      sourceRuns: SOURCE_RUNS,
      transcriptReads: { reads: 0, bytes: 0, longLines: 0, largestLine: 0 },
      collector: { sessions: 1, retiring: 0 },
      runs: { started: 3, failed: 1, timedOut: 1, refused: 0, running: 0 },
      frameFeeds: {
        feeds: 0,
        subscribers: 0,
        pushed: 0,
        refused: 0,
        lookups: 0,
        found: 0,
      },
      watchers: {
        active: 5,
        opened: 7,
        closed: 2,
        refused: 1,
        errors: 3,
        dirs: { active: 4, opened: 6, closed: 2 },
        polled: 3,
      },
      subprocesses: {
        total: 0,
        inFlight: 0,
        lastMinute: 0,
        byCategory: {},
        refused: {},
        draining: 0,
        drainedBytes: 0,
        drainsCut: 0,
        pipeErrors: 0,
        durations: {},
      },
      clients: [],
      bundle: "/",
      host: {
        pid: 1234,
        memory: {
          kind: "measured",
          charge: {
            kind: "charged",
            measure: "phys_footprint",
            bytes: 40 * MB,
          },
          usage: { kind: "read", sizes: { rss: 50 * MB, heapTotal: 30 * MB } },
        },
        limit: 512 * MB,
        nearAt: 384 * MB,
      },
      renderers: [
        {
          name: MAIN_RENDERER,
          process: {
            kind: "process",
            memory: {
              pid: 4343,
              memory: {
                kind: "measured",
                charge: {
                  kind: "charged",
                  measure: "phys_footprint",
                  bytes: 420 * MB,
                },
                usage: {
                  kind: "read",
                  sizes: { rss: 450 * MB, heapTotal: 200 * MB },
                },
              },
              limit: 512 * MB,
              nearAt: 384 * MB,
            },
          },
          mailbox: { holder: "render", heldMs: 12, queued: 2 },
          stats: {
            kind: "ok",
            value: {
              renderCache: {
                size: 4,
                held: 0,
                retired: 1,
                compiles: 2,
                views: 0,
                pinned: 0,
                retiredViews: 0,
                passages: 0,
                accountedBytes: 32 * MB,
                budgetBytes: 128 * MB,
              },
              effectCache: { sessions: 2, effects: 3 },
              menuIdle: { sessions: 2, armed: 1 },
              rendererTurns: { parked: 2, presents: 1, deferrals: 3 },
              sessionState: { sessions: 2, observers: 11, revision: 7 },
              framesDrawn: 9,
            },
          },
        },
        {
          name: rendererNameOf("worktree"),
          process: { kind: "not-running", why: "it exited 1" },
          mailbox: { holder: null, heldMs: 0, queued: 0 },
          stats: { kind: "failed", reason: "renderer worktree is down" },
        },
        {
          name: rendererNameOf("site"),
          process: { kind: "in-host" },
          mailbox: { holder: null, heldMs: 0, queued: 0 },
          stats: { kind: "ok", value: EMPTY_RENDERER_STATS },
        },
      ],
    });
    expect(out).toContain("pid           1234");
    expect(out).toContain(
      "memory        phys_footprint 40 MB of limit 512 MB (rss 50 MB, v8 heap 30 MB)\n",
    );
    // Every renderer's panel from one printer, whatever its name.
    expect(out).toContain(
      [
        "renderer main",
        "  process       pid 4343",
        "  memory        phys_footprint 420 MB of limit 512 MB (rss 450 MB, v8 heap 200 MB), approaching its limit",
        "  mailbox       holder render · held 12ms · queued 2",
        "  renderCache",
      ].join("\n"),
    );
    expect(out).toContain(
      [
        "renderer worktree",
        "  process       not running: it exited 1",
        "  mailbox       holder - · held 0ms · queued 0",
        "  stats         unanswered: renderer worktree is down",
      ].join("\n"),
    );
    expect(out).toContain(
      "renderer site\n  process       the host's, charged as the host's\n",
    );
    expect(out).toContain("env misses    3");
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
      "session/cache             failures=1 last=0ms refreshes first:1 period:0 change:2",
    );
    expect(out).toContain(
      "homes         daemon:1 configDir:1 repo:4 session:10 pane:2",
    );
    expect(out).toContain(
      "held          git:1 tmux:1 host:2 today:1 pluginStorage:1 transcript:3",
    );
    expect(out).toContain(
      "plugin storage folders=1 lost=1 faults unusable:0 unreadable:0 refused:1 error:0",
    );
    expect(out).toContain(
      "fileEvents    stalled unvouched since 2026-10-27T04:00:00.000Z stalls=2 catchUps=1 probes=7 probeFailures=1",
    );
    expect(out).toContain(
      "runs.shell    entries=1 held=1 failures=1 abandoned=1 last=12ms",
    );
    expect(out).toContain(
      "runs.file     entries=0 held=0 failures=0 abandoned=0 last=-",
    );
    expect(out).toContain("runs.watches  1");
    expect(out).toContain(
      "took          p50 3.1ms · p90 5ms · p99 11.2ms · max 161ms",
    );
    expect(out).toContain("refused       1");
    expect(out).toContain("errors        3");
    expect(out).toContain("polled        3 paths");
    expect(out).toContain("active        5");
    expect(out).toContain("effects       3");
    expect(out).toContain(
      "  turns\n    parked        2\n    presents      1\n    deferrals     3",
    );
    expect(out).toContain("framesDrawn   9");
    expect(out).toContain("armed         1");
    expect(out).toContain("observers     11");
    expect(out).toContain("revision      7");
    expect(out).toContain("compiles      2");
    expect(out).toContain("accounted     32.0MB / 128.0MB");
  });

  test("a refused row sits in the column the rows above it use", () => {
    const snap = emptyStats();
    const out = formatStats({
      ...snap,
      subprocesses: {
        ...snap.subprocesses,
        byCategory: { git: 1 },
        durations: {},
        refused: { "click.pbcopy": 3 },
      },
    });

    const width = "click.pbcopy refused".length;
    expect(out).toContain(`  ${"git".padEnd(width)} 1\n`);
    expect(out).toContain(`  ${"click.pbcopy refused".padEnd(width)} 3\n`);
  });

  test("near the limit is judged on the daemon's line, not this build's", () => {
    const snap = emptyStats();
    const at = (nearAt: number) =>
      formatStats({
        ...snap,
        host: {
          pid: 1234,
          memory: {
            kind: "measured",
            charge: { kind: "charged", measure: "rss", bytes: 40 * MB },
            usage: { kind: "read", sizes: { rss: 40 * MB, heapTotal: 0 } },
          },
          limit: 512 * MB,
          nearAt,
        },
      });
    expect(at(32 * MB)).toContain(
      "memory        rss 40 MB of limit 512 MB (rss 40 MB, v8 heap 0 MB), approaching its limit\n",
    );
    expect(at(384 * MB)).toContain(
      "memory        rss 40 MB of limit 512 MB (rss 40 MB, v8 heap 0 MB)\n",
    );
  });

  test("a renderer nothing could charge says so, and is never called near its limit", () => {
    const snap = emptyStats();
    const why =
      "footprint printed no phys_footprint for pid 4343, and no ping has answered yet";
    const out = formatStats({
      ...snap,
      renderers: [
        {
          name: MAIN_RENDERER,
          process: {
            kind: "process",
            memory: {
              pid: 4343,
              memory: {
                kind: "measured",
                charge: { kind: "unread", gap: 0, unread: why },
                usage: { kind: "unread", why: "no ping has answered yet" },
              },
              limit: 512 * MB,
              nearAt: 384 * MB,
            },
          },
          mailbox: { holder: null, heldMs: 0, queued: 0 },
          stats: { kind: "ok", value: EMPTY_RENDERER_STATS },
        },
      ],
    });
    expect(out).toContain(
      `  memory        unread (${why}) of limit 512 MB (no sizes: no ping has answered yet)\n`,
    );
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
      requests: {
        environmentMisses: 0,
        total: 0,
        errored: 0,
        timedOut: 0,
        inFlight: 0,
        took: NO_DURATIONS,
      },
      tasksThrew: 0,
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
      sources: emptyStats().sources,
      fileEvents: emptyStats().fileEvents,
      sourceRuns: emptyStats().sourceRuns,
      transcriptReads: { reads: 0, bytes: 0, longLines: 0, largestLine: 0 },
      collector: { sessions: 1, retiring: 0 },
      runs: { started: 0, failed: 0, timedOut: 0, refused: 0, running: 0 },
      frameFeeds: {
        feeds: 0,
        subscribers: 0,
        pushed: 0,
        refused: 0,
        lookups: 0,
        found: 0,
      },
      watchers: {
        active: 0,
        opened: 0,
        closed: 0,
        refused: 0,
        errors: 0,
        dirs: { active: 0, opened: 0, closed: 0 },
        polled: 0,
      },
      subprocesses: {
        total: 0,
        inFlight: 0,
        lastMinute: 0,
        byCategory: {},
        refused: {},
        draining: 0,
        drainedBytes: 0,
        drainsCut: 0,
        pipeErrors: 0,
        durations: {},
      },
      clients: [],
      bundle: "/",
      host: { pid: 1234, memory: { kind: "unmeasured" }, limit: 1, nearAt: 0 },
      renderers: [],
    });
    expect(out).toContain("hit rate      n/a");
    expect(out).toContain("memory        unmeasured (limit 0 MB)");
  });
});

// [LAW:verifiable-goals] The text/exit-code contract of `daemon-stats` is a
// plan value (src/cli-plan.ts delivers it), so it is pinned here without a
// process.
describe("statsPlan — the text/exit-code contract", () => {
  const snap = emptyStats();

  it("JSON mode carries the whole snapshot on stdout and exits 0", () => {
    const plan = statsPlan(
      { kind: "ok", value: { kind: "ours", snapshot: snap } },
      true,
    );
    expect(plan.code).toBe(0);
    expect(plan.stderr).toBe("");
    expect(JSON.parse(plan.stdout)).toEqual(JSON.parse(JSON.stringify(snap)));
  });

  it("text mode carries the formatted report", () => {
    const plan = statsPlan(
      { kind: "ok", value: { kind: "ours", snapshot: snap } },
      false,
    );
    expect(plan).toEqual({ stdout: formatStats(snap), stderr: "", code: 0 });
  });

  it("a skewed daemon's JSON is still delivered, beside the skew and a failing code", () => {
    const { clients: _clients, ...older } = snap;
    const plan = statsPlan({ kind: "ok", value: statsReplyOf(older) }, true);
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
