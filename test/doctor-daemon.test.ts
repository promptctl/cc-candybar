// brandon-doctor-v62x.5mq — the doctor's daemon row: exactly one daemon runs,
// it holds well under its memory budget, and it has died of memory no time
// the user has not been told of.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkByName, unreadPostMortems, type DaemonFacts, type Verdict } from "../src/doctor/checks";
import { applyFix, daemonProcesses, ownsEntry } from "../src/doctor/edge";
import { parseDoctorStores, parseServingDaemon } from "../src/doctor/daemon-answer";
import { daemonFields } from "../src/doctor/report";
import { filePostMortemsRead, parsePostMortemsRead } from "../src/doctor/post-mortems-read";
import { RuntimeStats } from "../src/daemon/stats";
import { postMortemsOf, type ServingDaemon } from "../src/daemon/limits";
import { EMPTY_STORES, HEALTHY_FACTS, HEALTHY_PROCESS, HEALTHY_SERVING, emptyStores } from "./helpers/doctor-facts";

const MB = 1024 * 1024;
const NEWER = "2026-10-19T18-01-12-345Z-77";
const OLDER = "2026-10-18T09-00-00-000Z-55";
const NEWER_REPORT = `/state/memory-${NEWER}.txt`;
const OLDER_HEAP = `/state/heap-${OLDER}.heapsnapshot`;

function verdictOf(daemon: Partial<DaemonFacts>): Verdict {
  return checkByName("daemon")!.probe({
    ...HEALTHY_FACTS,
    daemon: { ...HEALTHY_FACTS.daemon, ...daemon },
  });
}

const withPostMortems = {
  serving: {
    kind: "ok",
    value: {
      ...HEALTHY_SERVING,
      postMortems: {
        kind: "ok",
        value: [
          { identity: NEWER, artifacts: { memoryReport: NEWER_REPORT } },
          // A breach whose memory report failed to write: its heap snapshot is
          // all there is to read.
          { identity: OLDER, artifacts: { heapSnapshot: OLDER_HEAP } },
        ],
      },
    },
  },
} as const;

describe("the daemon probe", () => {
  test("one daemon, under its budget, no post-mortems: ok", () => {
    expect(verdictOf({})).toEqual({ ok: true });
  });

  test("unread post-mortems lead, newest first, each naming what it left; [fix] files the newest read", () => {
    expect(verdictOf(withPostMortems)).toEqual({
      ok: false,
      reason: `the daemon ran out of memory and restarted (${NEWER}) — post-mortem: ${NEWER_REPORT}`,
      more: [`the daemon ran out of memory and restarted (${OLDER}) — post-mortem: ${OLDER_HEAP}`],
      fix: { kind: "post-mortems-read", through: NEWER },
    });
  });

  test("only post-mortems newer than the one filed read are reported", () => {
    expect(verdictOf({ ...withPostMortems, read: { kind: "ok", value: { through: OLDER } } })).toMatchObject({
      ok: false,
      more: [],
      fix: { kind: "post-mortems-read", through: NEWER },
    });
    expect(verdictOf({ ...withPostMortems, read: { kind: "ok", value: { through: NEWER } } })).toEqual({ ok: true });
  });

  // The charge as the platform measures it, RSS beside it well over.
  const charged = (bytes: number): ServingDaemon["memory"] => ({
    kind: "measured",
    charge: { kind: "charged", measure: "phys_footprint", bytes },
    rss: 600 * MB,
    heapTotal: 100 * MB,
  });

  test("past three quarters of the budget by the charge fails, naming the measure; at it does not", () => {
    const at = (bytes: number) =>
      verdictOf({ serving: { kind: "ok", value: { ...HEALTHY_SERVING, memory: charged(bytes) } } });
    expect(at(384 * MB)).toEqual({ ok: true });
    expect(at(400 * MB)).toEqual({
      ok: false,
      reason:
        "the daemon holds phys_footprint 400 MB of its 512 MB limit — at the limit it records a post-mortem and restarts",
      more: [],
    });
  });

  // A stand-in judged at `bytes`: RSS less `gap`.
  const standInFacts = (bytes: number, gap: number): Pick<DaemonFacts, "serving"> => ({
    serving: {
      kind: "ok",
      value: {
        ...HEALTHY_SERVING,
        memory: {
          kind: "measured",
          charge: { kind: "stand-in", bytes, gap, unread: "footprint timeout" },
          rss: bytes + gap,
          heapTotal: 100 * MB,
        },
      },
    },
  });
  const standIn = (bytes: number, gap: number) => verdictOf(standInFacts(bytes, gap));

  test("RSS standing in with no gap read is a finding however far under the limit, and is judged too", () => {
    const unread =
      "the daemon could not read what macOS charges it (footprint timeout), so its memory limit judges RSS, which counts pages macOS has reclaimed";
    expect(standIn(100 * MB, 0)).toEqual({ ok: false, reason: unread, more: [] });
    expect(standIn(450 * MB, 0)).toEqual({
      ok: false,
      reason: unread,
      more: [
        "the daemon holds rss 450 MB (standing in: footprint timeout) of its 512 MB limit — at the limit it records a post-mortem and restarts",
      ],
    });
  });

  // brandon-unfiled-3248.ptv0: a stand-in is judged less the gap RSS last ran
  // over the footprint, and the row says so — near the limit by that estimate.
  test("RSS standing in less its gap is a finding naming the estimate, near the limit by it", () => {
    const unread =
      "the daemon could not read what macOS charges it (footprint timeout), so its memory limit judges RSS less the 150 MB it last ran over that charge, an estimate";
    expect(standIn(300 * MB, 150 * MB)).toEqual({ ok: false, reason: unread, more: [] });
    expect(standIn(450 * MB, 150 * MB)).toEqual({
      ok: false,
      reason: unread,
      more: [
        "the daemon holds rss 600 MB less its last 150 MB gap (standing in: footprint timeout) of its 512 MB limit — at the limit it records a post-mortem and restarts",
      ],
    });
  });

  test("the doctor's event carries the gap a stand-in is judged less, and a charge as it was", () => {
    const facts = { ...HEALTHY_FACTS.daemon, ...standInFacts(450 * MB, 150 * MB) };
    expect(daemonFields(facts)).toMatch(/ memory=rss-stand-in\(-150\):450\/512 /);
    expect(daemonFields(HEALTHY_FACTS.daemon)).toMatch(/ memory=phys_footprint:120\/512 /);
  });

  test("a daemon that has not measured its memory passes saying so", () => {
    expect(
      verdictOf({ serving: { kind: "ok", value: { ...HEALTHY_SERVING, memory: { kind: "unmeasured" } } } }),
    ).toEqual({ ok: true, note: "the daemon has not measured its memory yet" });
  });

  test("every daemon beside the serving one is named, its parent too when one lives", () => {
    const verdict = verdictOf({
      processes: {
        kind: "ok",
        value: [
          HEALTHY_PROCESS,
          { pid: 4200, ppid: 1, rss: 300 * MB, started: "Sun Oct 18 09:00:00 2026 UTC" },
          { pid: 4300, ppid: 999, rss: 90 * MB, started: "Mon Oct 19 18:20:01 2026 UTC" },
        ],
      },
    });
    expect(verdict).toEqual({
      ok: false,
      reason:
        "daemon 4200 (started Sun Oct 18 09:00:00 2026 UTC, rss 300 MB) runs beside the one serving the bar (4100) — `kill 4200`",
      more: [
        "daemon 4300 (started Mon Oct 19 18:20:01 2026 UTC, rss 90 MB, child of 999) runs beside the one serving the bar (4100) — `kill 4300`",
      ],
    });
  });

  test("a post-mortem leads a memory problem, so the row carries its fix", () => {
    const verdict = verdictOf({
      serving: {
        kind: "ok",
        value: { ...withPostMortems.serving.value, memory: charged(500 * MB) },
      },
    });
    expect(verdict).toMatchObject({ ok: false, fix: { kind: "post-mortems-read", through: NEWER } });
    expect(verdict.ok === false && verdict.more?.at(-1)).toMatch(/^the daemon holds phys_footprint 500 MB/);
  });

  test("no daemon answering is the failure, naming any daemon running, never as a stray", () => {
    expect(
      verdictOf({ serving: { kind: "failed", reason: "connect ENOENT /tmp/s" } }),
    ).toEqual({
      ok: false,
      reason: "connect ENOENT /tmp/s — daemon 4100 running",
      more: [],
    });
    expect(
      verdictOf({
        serving: { kind: "failed", reason: "connect ENOENT /tmp/s" },
        processes: { kind: "ok", value: [] },
      }),
    ).toEqual({ ok: false, reason: "connect ENOENT /tmp/s", more: [] });
  });

  test("the newest listed, filed read, leaves none unread — two breaches in one instant included", () => {
    const listed = postMortemsOf([
      "/s/memory-2026-10-19T18-01-12-345Z-999.txt",
      "/s/memory-2026-10-19T18-01-12-345Z-1000.txt",
    ]);
    const serving = { ...HEALTHY_SERVING, postMortems: { kind: "ok", value: listed } } as const;
    expect(unreadPostMortems(serving, { kind: "ok", value: { through: null } })).toHaveLength(2);
    expect(unreadPostMortems(serving, { kind: "ok", value: { through: listed[0]!.identity } })).toEqual([]);
  });

  test("no daemon answering keeps the process table's failure; which were read decides nothing with none listed", () => {
    expect(
      verdictOf({
        serving: { kind: "failed", reason: "connect ENOENT /tmp/s" },
        processes: { kind: "failed", reason: "ps failed (timeout)" },
        read: { kind: "failed", reason: "/s/read.json is not JSON" },
      }),
    ).toEqual({
      ok: false,
      reason: "connect ENOENT /tmp/s",
      more: ["the process table could not be read: ps failed (timeout)"],
    });
    expect(verdictOf({ read: { kind: "failed", reason: "/s/read.json is not JSON" } })).toEqual({ ok: true });
  });

  test("a list that cannot be read is its own problem, and no post-mortem is judged — or fixed — without the record", () => {
    expect(
      verdictOf({ processes: { kind: "failed", reason: "ps failed (spawn-error: ENOENT)" } }),
    ).toEqual({
      ok: false,
      reason: "the process table could not be read: ps failed (spawn-error: ENOENT)",
      more: [],
    });
    expect(
      verdictOf({
        serving: {
          kind: "ok",
          value: { ...HEALTHY_SERVING, postMortems: { kind: "failed", reason: "EACCES /state" } },
        },
      }),
    ).toEqual({
      ok: false,
      reason: "the daemon's post-mortems could not be listed: EACCES /state",
      more: [],
    });
    expect(
      verdictOf({ ...withPostMortems, read: { kind: "failed", reason: "/r.json is not JSON" } }),
    ).toEqual({
      ok: false,
      reason: "which post-mortems were read could not be read: /r.json is not JSON",
      more: [],
    });
    // A list that could not be read may hold breaches, so the record still counts.
    expect(
      verdictOf({
        serving: {
          kind: "ok",
          value: { ...HEALTHY_SERVING, postMortems: { kind: "failed", reason: "EACCES /state" } },
        },
        read: { kind: "failed", reason: "/r.json is not JSON" },
      }),
    ).toEqual({
      ok: false,
      reason: "the daemon's post-mortems could not be listed: EACCES /state",
      more: ["which post-mortems were read could not be read: /r.json is not JSON"],
    });
  });
});

// The process table as `ps -U <uid> -ww -o pid=,ppid=,rss=,lstart=,args=`
// prints it under LC_ALL=C TZ=UTC — each daemon row's args captured from a
// live process of its starter.
const TABLE = [
  // The spawners (acquire.ts, launch.rs), from a checkout.
  "22179     1 341552 Mon Oct 19 17:59:51 2026     node --max-old-space-size=1024 /Users/bmf/code/cc-candybar/bin/../dist/index.mjs daemon",
  // ...and from the staged runtime, whose path holds a space.
  "  501     1 300000 Mon Oct 19 09:00:00 2026     node --max-old-space-size=1024 /Users/bmf/Library/Application Support/CCCandybar/dist/index.mjs daemon",
  // The test harness: tsx's wrapper, and the worker that holds the socket.
  "28214     1  40000 Mon Oct 19 18:20:01 2026     node /repo/node_modules/.bin/../tsx/dist/cli.mjs /repo/src/index.ts daemon",
  "28227 28214 200000 Mon Oct 19 18:20:01 2026     /opt/homebrew/Cellar/node/26.7.0/bin/node --require /repo/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/preflight.cjs --import file:///repo/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs /repo/src/index.ts daemon",
  // A hand run, through an npm global bin.
  "  600     1   1000 Mon Oct  5 01:02:03 2026     node /usr/local/bin/cc-candybar daemon",
  // Not cc-candybar's: another tool's daemon, a relative hand run, other work.
  "  700     1   1000 Mon Oct 19 10:00:00 2026     node /tmp/other/dist/index.mjs daemon",
  "  800     1   1000 Mon Oct 19 10:00:00 2026     node ./node_modules/.bin/../tsx/dist/cli.mjs src/index.ts daemon",
  "  900     1   1000 Mon Oct 19 10:00:00 2026     node /x/server.js serve",
  "  950     1   1000 Mon Oct 19 10:00:00 2026     node /Users/bmf/code/cc-candybar/dist/index.mjs frames",
  "",
].join("\n");

describe("daemonProcesses", () => {
  test("every starter's shape is a daemon; a launcher is its worker's; another tool's entry is not", () => {
    const asked: string[] = [];
    const found = daemonProcesses(TABLE, (entry) => {
      asked.push(entry);
      return !entry.startsWith("/tmp/other/");
    });
    expect(found).toEqual([
      { pid: 22179, ppid: 1, rss: 341552 * 1024, started: "Mon Oct 19 17:59:51 2026 UTC" },
      { pid: 501, ppid: 1, rss: 300000 * 1024, started: "Mon Oct 19 09:00:00 2026 UTC" },
      { pid: 28227, ppid: 28214, rss: 200000 * 1024, started: "Mon Oct 19 18:20:01 2026 UTC" },
      { pid: 600, ppid: 1, rss: 1000 * 1024, started: "Mon Oct 5 01:02:03 2026 UTC" },
    ]);
    // The entry is the whole absolute path before ` daemon`, space and all;
    // a relative one and a non-daemon command are never asked about.
    expect(asked).toEqual([
      "/Users/bmf/code/cc-candybar/bin/../dist/index.mjs",
      "/Users/bmf/Library/Application Support/CCCandybar/dist/index.mjs",
      "/repo/src/index.ts",
      "/repo/src/index.ts",
      "/usr/local/bin/cc-candybar",
      "/tmp/other/dist/index.mjs",
    ]);
  });
});

describe("ownsEntry", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owns-")));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const touch = (p: string): string => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "");
    return p;
  };

  test("an entry beside bin/cc-candybar is cc-candybar's, through `..` and through a link", () => {
    const pkg = path.join(root, "pkg");
    touch(path.join(pkg, "bin", "cc-candybar"));
    touch(path.join(pkg, "dist", "index.mjs"));
    touch(path.join(pkg, "src", "index.ts"));
    expect(ownsEntry(path.join(pkg, "bin", "..", "dist", "index.mjs"))).toBe(true);
    expect(ownsEntry(path.join(pkg, "src", "index.ts"))).toBe(true);
    expect(ownsEntry(path.join(pkg, "bin", "cc-candybar"))).toBe(true);
    // An npm `.bin` launcher is a link to the package's bin.
    const dotBin = path.join(root, "node_modules", ".bin");
    fs.mkdirSync(dotBin, { recursive: true });
    fs.symlinkSync(path.join(pkg, "bin", "cc-candybar"), path.join(dotBin, "cc-candybar"));
    expect(ownsEntry(path.join(dotBin, "cc-candybar"))).toBe(true);
  });

  test("an entry of the same name with no cc-candybar beside it, or none at all, is not", () => {
    expect(ownsEntry(touch(path.join(root, "other", "dist", "index.mjs")))).toBe(false);
    expect(ownsEntry(touch(path.join(root, "x", "server.js")))).toBe(false);
    expect(ownsEntry(path.join(root, "gone", "dist", "index.mjs"))).toBe(false);
  });
});

describe("parseDoctorStores", () => {
  const stats = RuntimeStats.referenceSnapshot();
  const stores = (doctorStores: unknown) =>
    parseDoctorStores({ ...stats, doctorStores: doctorStores as typeof stats.doctorStores });

  test("what the daemon read of each store, or why it could not", () => {
    const read = { kind: "ok", value: { through: NEWER } } as const;
    const unread = { kind: "failed", reason: "/s/doctor-marks.json is not JSON" } as const;
    expect(stores({ ...EMPTY_STORES, marks: unread, postMortemsRead: read })).toEqual({
      ...EMPTY_STORES,
      marks: unread,
      postMortemsRead: read,
    });
  });

  test("a daemon from before the field is the build skew in every store; a misshapen store is named", () => {
    const { doctorStores: _, ...older } = stats;
    const skewed = parseDoctorStores(older as typeof stats);
    expect(skewed.marks).toMatchObject({ kind: "failed" });
    expect(skewed.clicked).toEqual(skewed.marks);
    expect(skewed.postMortemsRead).toEqual(skewed.marks);
    const odd = { kind: "ok", value: [3] };
    expect(stores({ ...EMPTY_STORES, clicked: odd }).clicked).toEqual({
      kind: "failed",
      reason: `the running daemon (${stats.version}) reported its clicked as ${JSON.stringify(odd)}, which is not a list of terminals`,
    });
    const unshaped = { kind: "maybe", value: {} };
    expect(stores({ ...EMPTY_STORES, marks: unshaped }).marks).toEqual({
      kind: "failed",
      reason: `the running daemon (${stats.version}) reported its marks as ${JSON.stringify(unshaped)}, which is not an answer`,
    });
  });
});

describe("parseServingDaemon", () => {
  const stats = RuntimeStats.referenceSnapshot();

  test("the daemon's report of itself", () => {
    const daemon = {
      ...HEALTHY_SERVING,
      postMortems: {
        kind: "ok" as const,
        value: [{ identity: NEWER, artifacts: { memoryReport: NEWER_REPORT } }],
      },
    };
    expect(parseServingDaemon({ ...stats, daemon })).toEqual({ kind: "ok", value: daemon });
    const unlisted = {
      ...HEALTHY_SERVING,
      postMortems: { kind: "failed" as const, reason: "EACCES" },
    };
    expect(parseServingDaemon({ ...stats, daemon: unlisted })).toEqual({
      kind: "ok",
      value: unlisted,
    });
  });

  test("a daemon from before the field is the build skew; a misshapen one is named whole", () => {
    const { daemon: _d, ...older } = stats;
    const skewed = parseServingDaemon(older as typeof stats);
    expect(skewed).toMatchObject({ kind: "failed" });
    expect(skewed.kind === "failed" && skewed.reason).toContain("reports no daemon");
    const unmeasured = { ...HEALTHY_SERVING, memory: { kind: "unmeasured" as const } };
    expect(parseServingDaemon({ ...stats, daemon: unmeasured })).toEqual({ kind: "ok", value: unmeasured });
    // A build from before the charge reported RSS under its own name.
    const { memory: _m, limit: _l, ...rest } = HEALTHY_SERVING;
    const rssEra = { ...rest, rss: 1, rssLimit: 2 };
    // It is told as the build skew it is, not as a misshapen answer.
    const rssEraRead = parseServingDaemon({ ...stats, daemon: rssEra as never });
    expect(rssEraRead.kind === "failed" && rssEraRead.reason).toContain(
      "reports no daemon.memory, daemon.limit; it is another build",
    );
    // RSS standing in must say why; without its reason it is misshapen.
    const reasonless = {
      ...HEALTHY_SERVING,
      memory: { kind: "measured", charge: { kind: "stand-in", bytes: 1, gap: 0 }, rss: 1, heapTotal: 1 },
    };
    expect(parseServingDaemon({ ...stats, daemon: reasonless as never })).toMatchObject({ kind: "failed" });
    // A stand-in must say the gap it is judged less, or its charge is RSS
    // passed off as an estimate.
    const standInGap = (gap: unknown) => ({
      ...HEALTHY_SERVING,
      memory: {
        kind: "measured",
        charge: { kind: "stand-in", bytes: 1, unread: "footprint timeout", gap },
        rss: 1,
        heapTotal: 1,
      },
    });
    for (const gap of [undefined, "150", Number.NaN]) {
      expect(parseServingDaemon({ ...stats, daemon: standInGap(gap) as never })).toMatchObject({ kind: "failed" });
    }
    expect(parseServingDaemon({ ...stats, daemon: standInGap(0) as never })).toMatchObject({ kind: "ok" });
    // A charged reading carries no gap, so one from before the gap still reads.
    expect(parseServingDaemon({ ...stats, daemon: HEALTHY_SERVING })).toMatchObject({ kind: "ok" });
    const odd = { ...HEALTHY_SERVING, postMortems: { kind: "ok", value: [{ identity: 3 }] } };
    expect(parseServingDaemon({ ...stats, daemon: odd as never })).toEqual({
      kind: "failed",
      reason: `the running daemon (${stats.version}) reported itself as ${JSON.stringify(odd)}`,
    });
  });
});

describe("the post-mortems-read record", () => {
  test("the document reads as the identity filed read, or fails saying so", () => {
    expect(parsePostMortemsRead({ through: NEWER })).toEqual({ kind: "ok", value: { through: NEWER } });
    expect(parsePostMortemsRead({ through: 3 })).toEqual({ kind: "failed", reason: "names no post-mortem read" });
    expect(parsePostMortemsRead(null)).toEqual({ kind: "failed", reason: "names no post-mortem read" });
  });

  test("every value the store can file reads back, none filed included", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-pm-read-"));
    try {
      const store = filePostMortemsRead(dir);
      store.update(() => ({ through: null }));
      expect(store.read()).toEqual({ kind: "ok", value: { through: null } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the fix files only forward: a newer breach another run filed stays filed", () => {
    const stores = emptyStores();
    const fix = { kind: "post-mortems-read", through: OLDER } as const;
    expect(applyFix(stores, fix, HEALTHY_FACTS)).toMatchObject({ kind: "ok", value: { daemon: { read: { kind: "ok", value: { through: OLDER } } } } });
    stores.postMortemsRead.update(() => ({ through: NEWER }));
    expect(applyFix(stores, fix, HEALTHY_FACTS)).toMatchObject({ kind: "ok", value: { daemon: { read: { kind: "ok", value: { through: NEWER } } } } });
    expect(stores.postMortemsRead.read()).toEqual({ kind: "ok", value: { through: NEWER } });
  });

  test("a record that stopped reading before the fix refuses it, and nothing is filed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-pm-read-"));
    try {
      const file = path.join(dir, "doctor-post-mortems-read.json");
      fs.writeFileSync(file, "junk");
      const stores = { ...emptyStores(), postMortemsRead: filePostMortemsRead(dir) };
      const fix = { kind: "post-mortems-read", through: NEWER } as const;
      expect(applyFix(stores, fix, HEALTHY_FACTS)).toMatchObject({
        kind: "failed",
        reason: expect.stringContaining(`${file} is not JSON`),
      });
      expect(fs.readFileSync(file, "utf8")).toBe("junk");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
