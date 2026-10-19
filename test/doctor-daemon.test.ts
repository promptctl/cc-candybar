// brandon-doctor-v62x.5mq — the doctor's daemon row: exactly one daemon runs,
// it holds well under its memory budget, and it has died of memory no time
// the user has not been told of.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkByName, type DaemonFacts, type Verdict } from "../src/doctor/checks";
import { daemonProcesses, ownsEntry } from "../src/doctor/edge";
import { parseServingDaemon } from "../src/doctor/daemon-answer";
import { filePostMortemsRead } from "../src/doctor/post-mortems-read";
import { RuntimeStats } from "../src/daemon/stats";
import { HEALTHY_FACTS, HEALTHY_PROCESS, HEALTHY_SERVING } from "./helpers/doctor-facts";

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
    expect(verdictOf({ ...withPostMortems, read: { kind: "ok", value: OLDER } })).toMatchObject({
      ok: false,
      more: [],
      fix: { kind: "post-mortems-read", through: NEWER },
    });
    expect(verdictOf({ ...withPostMortems, read: { kind: "ok", value: NEWER } })).toEqual({ ok: true });
  });

  test("past three quarters of the budget fails, naming both numbers; at it does not", () => {
    const at = (rss: number) =>
      verdictOf({ serving: { kind: "ok", value: { ...HEALTHY_SERVING, rss } } });
    expect(at(384 * MB)).toEqual({ ok: true });
    expect(at(400 * MB)).toEqual({
      ok: false,
      reason:
        "the daemon holds 400 MB of its 512 MB limit — at the limit it records a post-mortem and restarts",
      more: [],
    });
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
        "daemon 4200 (started Sun Oct 18 09:00:00 2026 UTC, 300 MB) runs beside the one serving the bar (4100) — `kill 4200`",
      more: [
        "daemon 4300 (started Mon Oct 19 18:20:01 2026 UTC, 90 MB, child of 999) runs beside the one serving the bar (4100) — `kill 4300`",
      ],
    });
  });

  test("a post-mortem leads a memory problem, so the row carries its fix", () => {
    const verdict = verdictOf({
      serving: {
        kind: "ok",
        value: { ...withPostMortems.serving.value, rss: 500 * MB },
      },
    });
    expect(verdict).toMatchObject({ ok: false, fix: { kind: "post-mortems-read", through: NEWER } });
    expect(verdict.ok === false && verdict.more?.at(-1)).toMatch(/^the daemon holds 500 MB/);
  });

  test("no daemon answering is the failure, naming any daemon running, never as a stray", () => {
    expect(
      verdictOf({ serving: { kind: "failed", reason: "connect ENOENT /tmp/s" } }),
    ).toEqual({
      ok: false,
      reason: "connect ENOENT /tmp/s — daemon 4100 running",
    });
    expect(
      verdictOf({
        serving: { kind: "failed", reason: "connect ENOENT /tmp/s" },
        processes: { kind: "ok", value: [] },
      }),
    ).toEqual({ ok: false, reason: "connect ENOENT /tmp/s" });
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
    const odd = { ...HEALTHY_SERVING, postMortems: { kind: "ok", value: [{ identity: 3 }] } };
    expect(parseServingDaemon({ ...stats, daemon: odd as never })).toEqual({
      kind: "failed",
      reason: `the running daemon (${stats.version}) reported itself as ${JSON.stringify(odd)}`,
    });
  });
});

describe("the post-mortems-read record", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmr-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("absent is none read; a filing reads back; text that does not read names the file", () => {
    const file = path.join(dir, "state", "read.json");
    const store = filePostMortemsRead(file);
    expect(store.read()).toEqual({ kind: "ok", value: null });
    store.record(NEWER);
    expect(store.read()).toEqual({ kind: "ok", value: NEWER });
    fs.writeFileSync(file, "{");
    expect(store.read()).toMatchObject({ kind: "failed", reason: expect.stringContaining(`${file} is not JSON`) });
    fs.writeFileSync(file, `{"through": 3}`);
    expect(store.read()).toEqual({ kind: "failed", reason: `${file} names no post-mortem read` });
  });
});
