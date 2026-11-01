import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ManagedStorage,
  STORAGE_FILE_MAX_AGE_MS,
  STORAGE_SWEEP_EVERY_MS,
} from "../src/daemon/cache/managed-storage";
import type { Delivery } from "../src/daemon/cache/file-events";
import {
  statIdentity,
  type FolderIdentity,
  type IdentityRead,
} from "../src/utils/folder-identity";
import {
  DEBOUNCE_MS,
  WatcherRegistry,
  type WatcherCounters,
} from "../src/daemon/cache/watchers";
import { sessionIdOf } from "../src/daemon/session-id";
import { Holds } from "../src/utils/holds";
import { ABSENT, ok } from "../src/utils/outcome";
import type { Current } from "../src/utils/reading";
import { until } from "./helpers/until";
import { fakeWatches } from "./helpers/fake-watches";
import { handDelivery, type HandDelivery } from "./helpers/hand-delivery";

// [LAW:behavior-not-structure] The managed storage owner through what it
// shows: what a session's lane reads, the refresh and sweep events it writes,
// and the stats — never which internal function ran.

const A = sessionIdOf("session-a");
const B = sessionIdOf("session-b");

interface Rig {
  readonly root: string;
  readonly folder: string;
  readonly storage: ManagedStorage;
  readonly fileEvents: HandDelivery;
  readonly counters: WatcherCounters;
  readonly lines: string[];
  write(sessionId: string, text: string): void;
}

const rigs: Rig[] = [];

function rig(opts: { identityOf?: IdentityRead } = {}): Rig {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "managed-storage-")),
  );
  const folder = path.join(root, "plug", "session");
  const counters: WatcherCounters = {
    watchersOpened: 0,
    watchersClosed: 0,
    watchRefusals: 0,
    watchErrors: 0,
    dirWatchesOpened: 0,
    dirWatchesClosed: 0,
  };
  const lines: string[] = [];
  const logger = (level: string, msg: string) => lines.push(`${level} ${msg}`);
  const watchers = new WatcherRegistry({ counters, logger });
  const fileEvents = handDelivery();
  const storage = new ManagedStorage({
    watchers,
    logger,
    fileEvents,
    identityOf: opts.identityOf,
  });
  const made: Rig = {
    root,
    folder,
    storage,
    fileEvents,
    counters,
    lines,
    // The program's contract: the whole file, renamed into place.
    write(sessionId, text) {
      const tmp = path.join(folder, `.${sessionId}.tmp`);
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, path.join(folder, `${sessionId}.json`));
    },
  };
  rigs.push(made);
  return made;
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  for (const r of rigs.splice(0)) {
    r.storage.close();
    fs.rmSync(r.root, { recursive: true, force: true });
  }
});

const answered = async <T>(lane: { current(): Current<T> }) => {
  await until(() => lane.current().kind !== "pending", "the lane's answer");
  return lane.current();
};

const refreshes = (r: Rig, by: string): string[] =>
  r.lines.filter(
    (l) => l.includes("plugin storage refresh") && l.includes(`by=${by}`),
  );

describe("ManagedStorage reads", () => {
  test("a session's file: ok, absent with no file or blank text, failed naming the path", async () => {
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    const release = r.storage.watch(key);
    const holds = new Holds();
    const C = sessionIdOf("session-c");
    r.write(A, '{"ceiling": 350000}');
    r.write(C, "  \n");
    r.write(B, "{not json");
    expect(await answered(r.storage.declare(holds, key, A))).toEqual(
      ok({ ceiling: 350000 }),
    );
    expect(
      await answered(r.storage.declare(holds, key, sessionIdOf("nobody"))),
    ).toEqual(ABSENT);
    expect(await answered(r.storage.declare(holds, key, C))).toEqual(ABSENT);
    const bad = await answered(r.storage.declare(holds, key, B));
    expect(bad).toMatchObject({ kind: "failed" });
    expect(bad.kind === "failed" && bad.reason).toMatch(
      new RegExp(
        `^${path.join(r.folder, "session-b.json")}: JSON parse failed`,
      ),
    );
    // Each read is one refresh event naming its file and its trigger.
    expect(refreshes(r, "first")).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^info plugin storage refresh file=${path.join(r.folder, "session-a.json")} generation=0 stored=Y by=first outcome=ok took=\\d+ms$`,
        ),
      ),
    );
    release();
  });

  test("the folder is created by the key request, before any session reads it", () => {
    const r = rig();
    expect(fs.existsSync(r.folder)).toBe(false);
    r.storage.keyFor(r.folder);
    expect(fs.statSync(r.folder).isDirectory()).toBe(true);
  });

  test("a program's write reaches its session's lane through the folder's watch", async () => {
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    r.storage.watch(key);
    r.write(A, '"a1"');
    const a = r.storage.declare(new Holds(), key, A);
    await answered(a);
    // FSEvents drops what lands before its stream is armed.
    await new Promise((resolve) => setTimeout(resolve, 100));
    r.write(A, '"a2"');
    await until(() => {
      const now = a.current();
      return now.kind === "ok" && now.value === "a2";
    }, "A's write");
  });

  test("a write to session A's file re-reads A only", async () => {
    const watches = fakeWatches();
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    r.storage.watch(key);
    r.write(A, '"a1"');
    r.write(B, '"b1"');
    const holds = new Holds();
    const a = r.storage.declare(holds, key, A);
    const b = r.storage.declare(holds, key, B);
    await answered(a);
    await answered(b);
    r.write(A, '"a2"');
    r.write(B, '"b2"');
    // The window names A's file, and the temp file beside it.
    watches[0]!.listener("rename", ".session-a.tmp");
    watches[0]!.listener("rename", "session-a.json");
    await until(() => {
      const now = a.current();
      return now.kind === "ok" && now.value === "a2";
    }, "A's write");
    expect(refreshes(r, "change")).toEqual([
      expect.stringContaining(`file=${path.join(r.folder, "session-a.json")} `),
    ]);
    expect(b.current()).toEqual(ok("b1"));
  });

  test("an unnamed event re-reads every held key in the folder, and only those", async () => {
    const watches = fakeWatches();
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    r.storage.watch(key);
    r.write(A, '"a1"');
    r.write(B, '"b1"');
    const holds = new Holds();
    const loose = new Holds();
    const a = r.storage.declare(holds, key, A);
    const b = r.storage.declare(holds, key, B);
    const c = r.storage.declare(loose, key, sessionIdOf("session-c"));
    await answered(a);
    await answered(b);
    await answered(c);
    loose.declare(() => {});
    r.write(A, '"a2"');
    r.write(B, '"b2"');
    watches[0]!.listener("rename", null);
    await until(() => {
      const [nowA, nowB] = [a.current(), b.current()];
      return (
        nowA.kind === "ok" &&
        nowA.value === "a2" &&
        nowB.kind === "ok" &&
        nowB.value === "b2"
      );
    }, "both held keys re-read");
    expect(refreshes(r, "change")).toHaveLength(2);
  });

  test("hold, release, write, hold again: the kept value draws until the re-read lands the write", async () => {
    const watches = fakeWatches();
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    r.storage.watch(key);
    r.write(A, '"before"');
    const holds = new Holds();
    await answered(r.storage.declare(holds, key, A));
    holds.declare(() => {});
    r.write(A, '"while away"');
    // The event finds the key unheld: nothing reads.
    watches[0]!.listener("rename", "session-a.json");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(refreshes(r, "change")).toHaveLength(0);
    const lane = r.storage.declare(holds, key, A);
    expect(lane.current()).toEqual(ok("before"));
    await until(() => {
      const now = lane.current();
      return now.kind === "ok" && now.value === "while away";
    }, "the hold's return re-read");
    expect(refreshes(r, "change")).toHaveLength(1);
  });

  test("a supersede holds back watch triggers until it resumes; two need both resumes", async () => {
    const watches = fakeWatches();
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    r.storage.watch(key);
    r.write(A, '"before"');
    const holds = new Holds();
    const lane = r.storage.declare(holds, key, A);
    await answered(lane);
    const one = r.storage.supersede(key, A);
    const two = r.storage.supersede(key, A);
    expect(lane.current()).toMatchObject({
      kind: "pending",
      why: "superseded",
    });
    r.write(A, '"after"');
    watches[0]!.listener("rename", "session-a.json");
    await new Promise((resolve) => setTimeout(resolve, 100));
    one();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lane.current()).toMatchObject({
      kind: "pending",
      why: "superseded",
    });
    expect(refreshes(r, "change")).toHaveLength(0);
    two();
    expect(await answered(lane)).toEqual(ok("after"));
    expect(refreshes(r, "supersede")).toHaveLength(1);
    expect(refreshes(r, "change")).toHaveLength(0);
  });
});

describe("ManagedStorage watches", () => {
  test("N holders of one folder, and views coming and going, open exactly one watch", async () => {
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    const releases = Array.from({ length: 5 }, () => r.storage.watch(key));
    for (let i = 0; i < 5; i++) {
      const view = new Holds();
      await answered(r.storage.declare(view, key, sessionIdOf(`s${i}`)));
      view.close();
    }
    expect(r.storage.keyFor(r.folder)).toEqual(key);
    expect(r.counters.watchersOpened).toBe(1);
    expect(r.storage.stats().folders).toBe(1);
    for (const release of releases) release();
    expect(r.counters.watchersClosed).toBe(1);
    expect(r.storage.stats().folders).toBe(0);
  });

  test("chmod, utimes and xattr on the folder leave its sources reading and open no watch", async () => {
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    r.storage.watch(key);
    r.write(A, '"a"');
    const lane = r.storage.declare(new Holds(), key, A);
    await answered(lane);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.chmodSync(r.folder, 0o700);
    fs.utimesSync(r.folder, new Date(), new Date());
    if (process.platform === "darwin") {
      execFileSync("xattr", ["-w", "candybar.test", "1", r.folder]);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lane.current()).toEqual(ok("a"));
    expect(r.storage.keyFor(r.folder)).toEqual(key);
    expect(r.storage.stats()).toMatchObject({
      lost: 0,
      faults: { unusable: 0, refused: 0, error: 0 },
    });
    expect(r.counters.watchersOpened).toBe(1);
  });

  test("a folder removed under its watch is lost, and the next key request is a new generation", async () => {
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    r.storage.watch(key);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(r.folder, { recursive: true });
    const next = r.storage.keyFor(r.folder);
    expect(next).toEqual({ folder: r.folder, generation: 1 });
    r.storage.watch(next);
    r.write(A, '"fresh"');
    expect(await answered(r.storage.declare(new Holds(), next, A))).toEqual(
      ok("fresh"),
    );
    expect(r.counters.watchersOpened).toBe(2);
  });

  test("a held file whose folder is removed reads what the path holds now, not its last value", async () => {
    const watches = fakeWatches();
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    r.storage.watch(key);
    r.write(A, '"a"');
    const lane = r.storage.declare(new Holds(), key, A);
    expect(await answered(lane)).toEqual(ok("a"));
    fs.rmSync(r.folder, { recursive: true });
    watches[0]!.listener("rename", path.basename(r.folder));
    await until(() => r.storage.stats().lost === 1, "the loss");
    await until(() => lane.current().kind !== "ok", "the re-read");
    expect(await answered(lane)).toEqual(ABSENT);
  });

  test("a folder that cannot be created is a standing fault of its sources, not a throw; the next key request tries again", async () => {
    const r = rig();
    // A file where the folder's parent should be: mkdir fails ENOTDIR.
    fs.writeFileSync(path.dirname(r.folder), "");
    const key = r.storage.keyFor(r.folder);
    r.storage.watch(key);
    const lane = r.storage.declare(new Holds(), key, A);
    expect(await answered(lane)).toEqual({
      kind: "failed",
      reason: expect.stringMatching(
        new RegExp(
          `^cannot refresh: ${r.folder} could not be created or read: ENOTDIR: .*; reload the config or restart the daemon$`,
        ),
      ),
    });
    expect(r.storage.stats().faults).toMatchObject({ unusable: 1 });
    expect(r.lines).toContainEqual(
      expect.stringMatching(
        /^warn plugin storage fault folder=\S+ generation=0 cause=unusable reason=/,
      ),
    );
    fs.rmSync(path.dirname(r.folder));
    const next = r.storage.keyFor(r.folder);
    expect(next.generation).toBe(1);
    r.storage.watch(next);
    r.write(A, '"a"');
    expect(await answered(r.storage.declare(new Holds(), next, A))).toEqual(
      ok("a"),
    );
  });

  // ext4 reuses a freed inode number: a folder deleted and created again can
  // carry the old device and inode. Only its birth time tells them apart.
  describe("a folder recreated with the same device and inode", () => {
    async function recreated() {
      const watches = fakeWatches();
      let birth = 1n;
      const identityOf: IdentityRead = (folder) => {
        const real = statIdentity(folder);
        if (real === "gone") return real;
        const same: FolderIdentity = { dev: 7n, ino: 42n, birthtimeNs: birth };
        return same;
      };
      const r = rig({ identityOf });
      const key = r.storage.keyFor(r.folder);
      r.storage.watch(key);
      const recreate = () => {
        fs.rmSync(r.folder, { recursive: true });
        fs.mkdirSync(r.folder);
        birth = 2n;
      };
      return { r, key, watches, recreate };
    }

    test("its own event first, then the config load: a new generation", async () => {
      const { r, key, watches, recreate } = await recreated();
      recreate();
      watches[0]!.listener("rename", path.basename(r.folder));
      // The fake watch's window closes on the registry's debounce.
      return until(() => r.storage.stats().lost === 1, "the loss").then(() => {
        expect(r.storage.keyFor(r.folder)).toEqual({ ...key, generation: 1 });
      });
    });

    test("the config load first, then its own event: a new generation, and the stale event marks nothing", async () => {
      const { r, key, watches, recreate } = await recreated();
      recreate();
      const next = r.storage.keyFor(r.folder);
      expect(next).toEqual({ ...key, generation: 1 });
      r.storage.watch(next);
      watches[0]!.listener("rename", path.basename(r.folder));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(r.storage.keyFor(r.folder)).toEqual(next);
      expect(r.storage.stats().lost).toBe(0);
    });
  });

  test("a refused watch is a standing fault on every source in the folder; the next key request is a new generation", async () => {
    const r0 = rig();
    fakeWatches(new Set([r0.folder]));
    const key = r0.storage.keyFor(r0.folder);
    r0.storage.watch(key);
    r0.write(A, '"a"');
    const lane = r0.storage.declare(new Holds(), key, A);
    expect(await answered(lane)).toEqual({
      kind: "failed",
      reason: `cannot refresh: ${r0.folder} EMFILE: too many open files, watch '${r0.folder}'; reload the config or restart the daemon`,
    });
    expect(r0.counters.watchRefusals).toBe(1);
    expect(r0.storage.stats().faults).toEqual({
      unusable: 0,
      refused: 1,
      error: 0,
    });
    jest.restoreAllMocks();
    const next = r0.storage.keyFor(r0.folder);
    expect(next.generation).toBe(1);
    r0.storage.watch(next);
    expect(await answered(r0.storage.declare(new Holds(), next, A))).toEqual(
      ok("a"),
    );
  });

  test("an error after open on a folder still there is the fault, and the held keys read it", async () => {
    const watches = fakeWatches();
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    r.storage.watch(key);
    r.write(A, '"a"');
    const lane = r.storage.declare(new Holds(), key, A);
    await answered(lane);
    watches[0]!.emitter.emit("error", new Error("EIO: i/o error"));
    await until(() => lane.current().kind === "failed", "the fault");
    expect(lane.current()).toEqual({
      kind: "failed",
      reason: `cannot refresh: ${r.folder} ${r.folder}: EIO: i/o error; reload the config or restart the daemon`,
    });
    expect(r.counters.watchErrors).toBe(1);
    expect(r.storage.stats().faults).toEqual({
      unusable: 0,
      refused: 0,
      error: 1,
    });
    expect(r.lines).toContainEqual(
      expect.stringMatching(
        /^warn plugin storage fault folder=\S+ generation=0 cause=error reason=/,
      ),
    );
    expect(r.storage.keyFor(r.folder).generation).toBe(1);
  });
});

// A watch the OS has stopped feeding reports nothing, as a quiet folder does;
// the owner's probe tells them apart. Fake intervals and clock turn the
// probe's period by hand; the registry's debounce stays real, so a fake
// watch's report lands one window later.
describe("ManagedStorage under the daemon's file-event delivery", () => {
  const STALLED_AT = Date.parse("2026-10-27T04:00:00.000Z");
  const stalled: Delivery = { kind: "stalled", missedSince: STALLED_AT };
  const delivering: Delivery = {
    kind: "delivering",
    unreported: [],
    missedSince: null,
  };
  // Long enough for a debounce window to close and nothing to follow it:
  // only for asserting that something did not happen.
  const quiet = () =>
    new Promise((resolve) => setTimeout(resolve, 3 * DEBOUNCE_MS));
  const stallReason = (folder: string) =>
    `cannot refresh: ${folder}: file events stopped at 2026-10-27T04:00:00.000Z; the OS has delivered none since, not even for a file the daemon wrote to test it`;
  const reads = (r: Rig) =>
    r.lines.filter((l) => l.includes("plugin storage refresh"));

  async function stalledRig() {
    const watches = fakeWatches();
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    r.storage.watch(key);
    r.write(A, '"a"');
    const lane = r.storage.declare(new Holds(), key, A);
    expect(await answered(lane)).toEqual(ok("a"));
    r.fileEvents.set(stalled, { kind: "moved" });
    await until(() => lane.current().kind === "failed", "the stall");
    return { r, key, lane, watch: watches[0]! };
  }

  test("while delivery is stalled every held lane reads the stall, naming its folder and the span's start", async () => {
    const { r, key, lane } = await stalledRig();
    const other = r.storage.declare(new Holds(), key, B);
    expect(lane.current()).toEqual({
      kind: "failed",
      reason: stallReason(r.folder),
    });
    expect(await answered(other)).toEqual({
      kind: "failed",
      reason: stallReason(r.folder),
    });
    // A stall is not a loss: the generation is still the right one.
    expect(r.storage.keyFor(r.folder)).toEqual(key);
    expect(r.storage.stats()).toMatchObject({ lost: 0 });
  });

  test("a catch-up re-reads every held lane, landing a write made during the span", async () => {
    const { r, lane } = await stalledRig();
    r.write(A, '"written during the stall"');
    r.fileEvents.set(delivering, {
      kind: "caught-up",
      since: STALLED_AT,
    });
    await until(() => lane.current().kind === "ok", "the re-read");
    expect(lane.current()).toEqual(ok("written during the stall"));
  });

  test("a catch-up reached through unmeasured re-reads too, and no lane keeps the stall once delivery moves on", async () => {
    const { r, lane } = await stalledRig();
    r.fileEvents.set(
      {
        kind: "unmeasured",
        since: STALLED_AT + 60_000,
        reason: "the probe could not be written: ENOSPC",
        missedSince: STALLED_AT,
      },
      { kind: "moved" },
    );
    // Unmeasured reads the files as usual: the bar's row says delivery
    // cannot be checked.
    await until(() => lane.current().kind === "ok", "the re-read");
    expect(lane.current()).toEqual(ok("a"));
    r.write(A, '"written while unmeasured"');
    r.fileEvents.set(
      { kind: "delivering", unreported: [1], missedSince: STALLED_AT },
      { kind: "moved" },
    );
    r.fileEvents.set(delivering, { kind: "caught-up", since: STALLED_AT });
    await until(
      () =>
        JSON.stringify(lane.current()) ===
        JSON.stringify(ok("written while unmeasured")),
      "the catch-up's re-read",
    );
  });

  test("a watch error during a stall is the fault its sources read", async () => {
    const { r, lane, watch } = await stalledRig();
    watch.emitter.emit("error", new Error("EIO: i/o error"));
    await until(
      () =>
        lane.current().kind === "failed" &&
        (lane.current() as { reason: string }).reason !== stallReason(r.folder),
      "the fault",
    );
    expect(lane.current()).toEqual({
      kind: "failed",
      reason: `cannot refresh: ${r.folder} ${r.folder}: EIO: i/o error; reload the config or restart the daemon`,
    });
    expect(r.storage.stats()).toMatchObject({
      faults: { unusable: 0, refused: 0, error: 1 },
    });
  });

  // The event naming the folder and the follower's event that reloads its
  // config ride one stream, which can drop both at once without a stall.
  test("a folder replaced while its own event was dropped is lost on the next period, and the next key request is a new generation", async () => {
    fakeWatches();
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    r.storage.watch(key);
    r.write(A, '"a"');
    const lane = r.storage.declare(new Holds(), key, A);
    expect(await answered(lane)).toEqual(ok("a"));
    fs.rmSync(r.folder, { recursive: true });
    fs.mkdirSync(r.folder);
    r.write(A, '"in the new folder"');
    await quiet();
    expect(r.storage.stats()).toMatchObject({ lost: 0 });
    r.fileEvents.notify({ kind: "period" });
    expect(r.storage.stats()).toMatchObject({ lost: 1 });
    await until(
      () =>
        lane.current().kind === "ok" &&
        JSON.stringify(lane.current()) ===
          JSON.stringify(ok("in the new folder")),
      "the re-read from the path",
    );
    expect(r.storage.keyFor(r.folder)).toEqual({ ...key, generation: 1 });
  });

  test("a folder removed under its watch is lost once, however many periods pass", async () => {
    fakeWatches();
    const r = rig();
    r.storage.watch(r.storage.keyFor(r.folder));
    fs.rmSync(r.folder, { recursive: true });
    for (let i = 0; i < 4; i++) r.fileEvents.notify({ kind: "period" });
    await quiet();
    expect(r.storage.stats()).toMatchObject({
      lost: 1,
      faults: { unusable: 0, refused: 0, error: 0 },
    });
    expect(
      r.lines.filter((l) => l.startsWith("info plugin storage lost")),
    ).toHaveLength(1);
  });

  // The reload that would move a lost folder on rides the same stalled
  // service, so a file read once from the path would freeze there unreported.
  test("a stalled folder replaced at the path is lost, and its lanes keep reading the stall", async () => {
    const { r, lane } = await stalledRig();
    fs.rmSync(r.folder, { recursive: true });
    fs.mkdirSync(r.folder);
    r.write(A, '"in the new folder"');
    r.fileEvents.notify({ kind: "period" });
    await until(() => r.storage.stats().lost === 1, "the loss");
    await quiet();
    expect(lane.current()).toEqual({
      kind: "failed",
      reason: stallReason(r.folder),
    });
  });

  test("a stalled folder found lost reads the path again on the catch-up", async () => {
    const { r, lane } = await stalledRig();
    fs.rmSync(r.folder, { recursive: true });
    fs.mkdirSync(r.folder);
    r.write(A, '"in the new folder"');
    r.fileEvents.notify({ kind: "period" });
    await until(() => r.storage.stats().lost === 1, "the loss");
    r.fileEvents.set(delivering, { kind: "caught-up", since: STALLED_AT });
    await until(() => lane.current().kind === "ok", "the re-read");
    expect(lane.current()).toEqual(ok("in the new folder"));
  });

  test("a period with delivery unchanged re-reads nothing", async () => {
    fakeWatches();
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    r.storage.watch(key);
    r.write(A, '"a"');
    const lane = r.storage.declare(new Holds(), key, A);
    expect(await answered(lane)).toEqual(ok("a"));
    const before = reads(r).length;
    for (let i = 0; i < 3; i++) r.fileEvents.notify({ kind: "period" });
    await quiet();
    expect(reads(r)).toHaveLength(before);
    expect(r.storage.stats()).toMatchObject({ lost: 0 });
  });
});

describe("ManagedStorage cleanup", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const age = (file: string, days: number) => {
    const at = new Date(Date.now() - days * DAY);
    fs.utimesSync(file, at, at);
  };

  test("a watch's opening removes only unheld files older than 30 days, and writes its event", async () => {
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    for (const sid of ["old", "held-old", "young"]) r.write(sid, "{}");
    fs.writeFileSync(path.join(r.folder, "old-notes.txt"), "");
    age(path.join(r.folder, "old.json"), 31);
    age(path.join(r.folder, "held-old.json"), 31);
    age(path.join(r.folder, "old-notes.txt"), 31);
    const holds = new Holds();
    await answered(r.storage.declare(holds, key, sessionIdOf("held-old")));
    r.storage.watch(key);
    await until(
      () => r.lines.some((l) => l.includes("plugin storage sweep")),
      "the sweep's event",
    );
    expect(fs.readdirSync(r.folder).sort()).toEqual([
      "held-old.json",
      "old-notes.txt",
      "young.json",
    ]);
    expect(r.lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^info plugin storage sweep folder=${r.folder} scanned=3 removed=1 took=\\d+ms$`,
        ),
      ),
    );
  });

  test("a file gone between the listing and its removal leaves the rest of the sweep to run", async () => {
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    for (const sid of ["a", "b"]) {
      r.write(sid, "{}");
      age(path.join(r.folder, `${sid}.json`), 31);
    }
    const stat = fs.promises.stat;
    jest.spyOn(fs.promises, "stat").mockImplementationOnce(async (file) => {
      // Another sweep removes it first.
      fs.unlinkSync(file);
      return stat(file);
    });
    r.storage.watch(key);
    await until(
      () => r.lines.some((l) => l.includes("plugin storage sweep")),
      "the sweep's event",
    );
    expect(fs.readdirSync(r.folder)).toEqual([]);
    expect(r.lines).toContainEqual(
      expect.stringMatching(
        /^info plugin storage sweep folder=\S+ scanned=2 removed=1 took=\d+ms$/,
      ),
    );
  });

  test("a held watch sweeps again once a day", async () => {
    jest.useFakeTimers({
      doNotFake: [
        "setTimeout",
        "clearTimeout",
        "setImmediate",
        "nextTick",
        "queueMicrotask",
      ],
    });
    const r = rig();
    const key = r.storage.keyFor(r.folder);
    r.storage.watch(key);
    await until(
      () => r.lines.filter((l) => l.includes("sweep")).length === 1,
      "the opening sweep",
    );
    r.write(A, "{}");
    jest.setSystemTime(Date.now() + STORAGE_FILE_MAX_AGE_MS + DAY);
    jest.advanceTimersByTime(STORAGE_SWEEP_EVERY_MS);
    await until(
      () => r.lines.filter((l) => l.includes("sweep")).length === 2,
      "the daily sweep",
    );
    expect(r.lines.at(-1)).toMatch(/scanned=1 removed=1 /);
    expect(fs.existsSync(path.join(r.folder, "session-a.json"))).toBe(false);
  });
});
