import { systemTimekeeper } from "../src/time";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ManagedStorage,
  STORAGE_FILE_MAX_AGE_MS,
  STORAGE_SWEEP_EVERY_MS,
} from "../src/daemon/cache/managed-storage";
import type { Delivery } from "../src/daemon/foundations/stats-snapshot";
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
import { sessionIdOf } from "../src/daemon/foundations/session-id";
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
  // A session's declaration of its file in the rig's folder, which makes and
  // watches the folder; the returned holds keep the file held until closed.
  open(): Holds;
  // The folder's generation, as the owner's last event about it said.
  generation(): number;
}

const rigs: Rig[] = [];

function rig(opts: { identityOf?: IdentityRead } = {}): Rig {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "managed-storage-")),
  );
  const folder = path.join(root, "plug", "session");
  // The plugin's folder: the owner makes only the storage folder in it.
  fs.mkdirSync(path.dirname(folder));
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
  const watchers = new WatcherRegistry({
    clock: systemTimekeeper,
    counters,
    logger,
  });
  const fileEvents = handDelivery();
  const storage = new ManagedStorage({
    clock: systemTimekeeper,
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
    open() {
      const holds = new Holds();
      storage.declare(holds, folder, sessionIdOf("watcher"));
      return holds;
    },
    generation() {
      const moved = lines.filter((l) =>
        l.startsWith(`info plugin storage generation folder=${folder} `),
      );
      return moved.length === 0
        ? 0
        : Number(/generation=(\d+)$/.exec(moved.at(-1)!)![1]);
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
    r.open();
    const holds = new Holds();
    const C = sessionIdOf("session-c");
    r.write(A, '{"ceiling": 350000}');
    r.write(C, "  \n");
    r.write(B, "{not json");
    expect(await answered(r.storage.declare(holds, r.folder, A))).toEqual(
      ok({ ceiling: 350000 }),
    );
    expect(
      await answered(r.storage.declare(holds, r.folder, sessionIdOf("nobody"))),
    ).toEqual(ABSENT);
    expect(await answered(r.storage.declare(holds, r.folder, C))).toEqual(
      ABSENT,
    );
    const bad = await answered(r.storage.declare(holds, r.folder, B));
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
          `^info plugin storage refresh file=${path.join(r.folder, "session-a.json")} by=first outcome=ok took=\\d+ms$`,
        ),
      ),
    );
  });

  test("the first declaration of a file makes its folder", () => {
    const r = rig();
    expect(fs.existsSync(r.folder)).toBe(false);
    r.open();
    expect(fs.statSync(r.folder).isDirectory()).toBe(true);
  });

  test("a plugin folder that is gone is not made again: its storage folder faults", async () => {
    const r = rig();
    fs.rmdirSync(path.dirname(r.folder));
    r.open();
    expect(fs.existsSync(path.dirname(r.folder))).toBe(false);
    expect(
      await answered(r.storage.declare(new Holds(), r.folder, A)),
    ).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("could not be created or read: ENOENT"),
    });
  });

  test("a file's folder is watched before the file is first read", async () => {
    const watches = fakeWatches();
    const r = rig();
    fs.mkdirSync(r.folder);
    r.write(A, '"a"');
    const lane = r.storage.declare(new Holds(), r.folder, A);
    expect(watches).toHaveLength(1);
    expect(await answered(lane)).toEqual(ok("a"));
    r.write(A, '"a2"');
    watches[0]!.listener("rename", "session-a.json");
    await until(
      () => JSON.stringify(lane.current()) === JSON.stringify(ok("a2")),
      "the watch's re-read",
    );
  });

  test("a program's write reaches its session's lane through the folder's watch", async () => {
    const r = rig();
    r.open();
    r.write(A, '"a1"');
    const a = r.storage.declare(new Holds(), r.folder, A);
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
    r.open();
    r.write(A, '"a1"');
    r.write(B, '"b1"');
    const holds = new Holds();
    const a = r.storage.declare(holds, r.folder, A);
    const b = r.storage.declare(holds, r.folder, B);
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
    r.open().close();
    r.write(A, '"a1"');
    r.write(B, '"b1"');
    const holds = new Holds();
    const loose = new Holds();
    const a = r.storage.declare(holds, r.folder, A);
    const b = r.storage.declare(holds, r.folder, B);
    const c = r.storage.declare(loose, r.folder, sessionIdOf("session-c"));
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
    r.open();
    r.write(A, '"before"');
    const holds = new Holds();
    await answered(r.storage.declare(holds, r.folder, A));
    holds.declare(() => {});
    r.write(A, '"while away"');
    // The event finds the key unheld: nothing reads.
    watches[0]!.listener("rename", "session-a.json");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(refreshes(r, "change")).toHaveLength(0);
    const lane = r.storage.declare(holds, r.folder, A);
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
    r.open();
    r.write(A, '"before"');
    const holds = new Holds();
    const lane = r.storage.declare(holds, r.folder, A);
    await answered(lane);
    const one = r.storage.supersede(r.folder, A);
    const two = r.storage.supersede(r.folder, A);
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
  // [LAW:no-ambient-temporal-coupling] Declarations come and go with every
  // renderer restart, reload and idle retire, and a directory watch closed and
  // opened again leaks on macOS: a folder's watch outlives them all.
  test("declarations coming and going, of any number of sessions, open one watch and close none", async () => {
    const r = rig();
    const first = r.open();
    for (let i = 0; i < 5; i++) {
      const view = new Holds();
      await answered(r.storage.declare(view, r.folder, sessionIdOf(`s${i}`)));
      view.close();
    }
    first.close();
    r.open().close();
    expect(r.generation()).toBe(0);
    expect(r.counters.watchersOpened).toBe(1);
    expect(r.counters.watchersClosed).toBe(0);
    expect(r.storage.stats().folders).toBe(1);
  });

  test("a folder nothing declares any more keeps its watch through periods and catch-ups until the owner closes", () => {
    const r = rig();
    r.open().close();
    r.fileEvents.notify({ kind: "period" });
    r.fileEvents.notify({ kind: "caught-up", since: 0 });
    expect(r.counters.watchersClosed).toBe(0);
    expect(r.storage.stats().folders).toBe(1);
    r.storage.close();
    expect(r.counters.watchersClosed).toBe(1);
    expect(r.storage.stats().folders).toBe(0);
  });

  // A render that was mid-wait as the daemon closed: no close comes after it.
  test("a declaration after the owner closes opens no watch", async () => {
    const r = rig();
    r.storage.close();
    const lane = r.storage.declare(new Holds(), r.folder, A);
    expect(await answered(lane)).toMatchObject({ kind: "failed" });
    expect(r.counters.watchersOpened).toBe(0);
    expect(r.storage.stats().folders).toBe(0);
  });

  test("chmod, utimes and xattr on the folder leave its sources reading and open no watch", async () => {
    const r = rig();
    r.open();
    r.write(A, '"a"');
    const lane = r.storage.declare(new Holds(), r.folder, A);
    await answered(lane);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.chmodSync(r.folder, 0o700);
    fs.utimesSync(r.folder, new Date(), new Date());
    if (process.platform === "darwin") {
      execFileSync("xattr", ["-w", "candybar.test", "1", r.folder]);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lane.current()).toEqual(ok("a"));
    r.open();
    expect(r.generation()).toBe(0);
    expect(r.storage.stats()).toMatchObject({
      lost: 0,
      faults: { unusable: 0, refused: 0, error: 0 },
    });
    expect(r.counters.watchersOpened).toBe(1);
  });

  // Not at once: a plugin folder being removed would have its storage folder
  // made in it again before its own removal, which then fails as not empty.
  test("a folder removed under its watch is made again by its owner at the next period, as a new generation, while a file in it is held", async () => {
    const watches = fakeWatches();
    const r = rig();
    r.open();
    fs.rmSync(r.folder, { recursive: true });
    watches[0]!.listener("rename", path.basename(r.folder));
    await until(() => r.storage.stats().lost === 1, "the loss");
    expect(r.generation()).toBe(0);
    expect(fs.existsSync(r.folder)).toBe(false);
    r.open();
    expect(fs.existsSync(r.folder)).toBe(false);
    r.fileEvents.notify({ kind: "period" });
    expect(r.generation()).toBe(1);
    expect(fs.statSync(r.folder).isDirectory()).toBe(true);
    r.write(A, '"fresh"');
    expect(await answered(r.storage.declare(new Holds(), r.folder, A))).toEqual(
      ok("fresh"),
    );
    expect(r.counters.watchersOpened).toBe(2);
    expect(r.counters.watchersClosed).toBe(1);
  });

  // An update replaces a plugin's folder by rename, which the watch, gone
  // with the old folder, never hears.
  test("a folder replaced unheard is made again at the period that finds it lost, while a file in it is held", () => {
    fakeWatches();
    const r = rig();
    r.open();
    fs.rmSync(r.folder, { recursive: true });
    r.fileEvents.notify({ kind: "period" });
    expect(r.storage.stats().lost).toBe(1);
    expect(r.generation()).toBe(1);
    expect(fs.statSync(r.folder).isDirectory()).toBe(true);
  });

  test("a removed plugin's folder, with no file in it held, is not made again: its watch closes at the period", async () => {
    const watches = fakeWatches();
    const r = rig();
    r.open().close();
    fs.rmSync(path.dirname(r.folder), { recursive: true });
    watches[0]!.listener("rename", path.basename(r.folder));
    await until(() => r.storage.stats().lost === 1, "the loss");
    r.fileEvents.notify({ kind: "period" });
    r.fileEvents.notify({ kind: "period" });
    expect(fs.existsSync(path.dirname(r.folder))).toBe(false);
    expect(r.counters.watchersOpened).toBe(1);
    expect(r.counters.watchersClosed).toBe(1);
    expect(r.storage.stats().folders).toBe(0);
  });

  test("a held file whose folder is removed reads what the path holds now, not its last value", async () => {
    const watches = fakeWatches();
    const r = rig();
    r.open();
    r.write(A, '"a"');
    const lane = r.storage.declare(new Holds(), r.folder, A);
    expect(await answered(lane)).toEqual(ok("a"));
    fs.rmSync(r.folder, { recursive: true });
    watches[0]!.listener("rename", path.basename(r.folder));
    await until(() => r.storage.stats().lost === 1, "the loss");
    await until(() => lane.current().kind !== "ok", "the re-read");
    expect(await answered(lane)).toEqual(ABSENT);
  });

  test("a folder that cannot be created is a standing fault of its sources, not a throw; the next period tries again", async () => {
    const r = rig();
    // A file where the folder's parent should be: mkdir fails ENOTDIR.
    fs.rmdirSync(path.dirname(r.folder));
    fs.writeFileSync(path.dirname(r.folder), "");
    r.open();
    const lane = r.storage.declare(new Holds(), r.folder, A);
    expect(await answered(lane)).toEqual({
      kind: "failed",
      failedAt: "read",
      reason: expect.stringMatching(
        new RegExp(
          `^cannot refresh: ${r.folder} could not be created or read: ENOTDIR: .*; retried at the next file-event period or catch-up$`,
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
    fs.mkdirSync(path.dirname(r.folder));
    // Every request declares again, so a declaration retries nothing.
    r.open();
    expect(r.storage.stats().faults).toMatchObject({ unusable: 1 });
    r.fileEvents.notify({ kind: "period" });
    expect(r.generation()).toBe(1);
    r.write(A, '"a"');
    // The lane carries across the generation, re-read once it opens.
    await until(() => lane.current().kind === "ok", "the re-read");
    expect(lane.current()).toEqual(ok("a"));
  });

  test("a file where the folder should be is a standing fault of its sources, never a folder", async () => {
    const r = rig();
    fs.writeFileSync(r.folder, "");
    r.open();
    const lane = r.storage.declare(new Holds(), r.folder, A);
    expect(await answered(lane)).toEqual({
      kind: "failed",
      failedAt: "read",
      reason: `cannot refresh: ${r.folder} could not be created or read: ${r.folder} is not a folder; retried at the next file-event period or catch-up`,
    });
    expect(r.storage.stats().faults).toMatchObject({ unusable: 1 });
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
      r.open();
      const recreate = () => {
        fs.rmSync(r.folder, { recursive: true });
        fs.mkdirSync(r.folder);
        birth = 2n;
      };
      return { r, watches, recreate };
    }

    test("its own event first, then the period: a new generation", async () => {
      const { r, watches, recreate } = await recreated();
      recreate();
      watches[0]!.listener("rename", path.basename(r.folder));
      // The fake watch's window closes on the registry's debounce.
      await until(() => r.storage.stats().lost === 1, "the loss");
      r.fileEvents.notify({ kind: "period" });
      expect(r.generation()).toBe(1);
    });

    test("the period first, then its own event: one new generation, and the stale event marks nothing", async () => {
      const { r, watches, recreate } = await recreated();
      recreate();
      r.fileEvents.notify({ kind: "period" });
      r.fileEvents.notify({ kind: "period" });
      expect(r.generation()).toBe(1);
      watches[0]!.listener("rename", path.basename(r.folder));
      await new Promise((resolve) => setTimeout(resolve, 150));
      r.fileEvents.notify({ kind: "period" });
      expect(r.generation()).toBe(1);
      expect(r.storage.stats().lost).toBe(1);
    });
  });

  test("a refused watch is a standing fault on every source in the folder; the next period opens a new generation", async () => {
    const r0 = rig();
    fakeWatches(new Set([r0.folder]));
    r0.open();
    r0.write(A, '"a"');
    const lane = r0.storage.declare(new Holds(), r0.folder, A);
    expect(await answered(lane)).toEqual({
      kind: "failed",
      failedAt: "read",
      reason: `cannot refresh: ${r0.folder} EMFILE: too many open files, watch '${r0.folder}'; retried at the next file-event period or catch-up`,
    });
    expect(r0.counters.watchRefusals).toBe(1);
    expect(r0.storage.stats().faults).toEqual({
      unusable: 0,
      refused: 1,
      error: 0,
    });
    jest.restoreAllMocks();
    r0.open();
    expect(r0.counters.watchRefusals).toBe(1);
    r0.fileEvents.notify({ kind: "period" });
    expect(r0.generation()).toBe(1);
    // The lane carries across the generation, re-read once it opens.
    await until(() => lane.current().kind === "ok", "the re-read");
    expect(lane.current()).toEqual(ok("a"));
  });

  test("an error after open on a folder still there is the fault, and the held keys read it", async () => {
    const watches = fakeWatches();
    const r = rig();
    r.open();
    r.write(A, '"a"');
    const lane = r.storage.declare(new Holds(), r.folder, A);
    await answered(lane);
    watches[0]!.emitter.emit("error", new Error("EIO: i/o error"));
    await until(() => lane.current().kind === "failed", "the fault");
    expect(lane.current()).toEqual({
      kind: "failed",
      failedAt: "read",
      reason: `cannot refresh: ${r.folder} ${r.folder}: EIO: i/o error; retried at the next file-event period or catch-up`,
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
    r.fileEvents.notify({ kind: "period" });
    expect(r.generation()).toBe(1);
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
    r.open();
    r.write(A, '"a"');
    const lane = r.storage.declare(new Holds(), r.folder, A);
    expect(await answered(lane)).toEqual(ok("a"));
    r.fileEvents.set(stalled, { kind: "moved" });
    await until(() => lane.current().kind === "failed", "the stall");
    return { r, lane, watch: watches[0]! };
  }

  test("while delivery is stalled every held lane reads the stall, naming its folder and the span's start", async () => {
    const { r, lane } = await stalledRig();
    const other = r.storage.declare(new Holds(), r.folder, B);
    expect(lane.current()).toEqual({
      kind: "failed",
      failedAt: "read",
      reason: stallReason(r.folder),
    });
    expect(await answered(other)).toEqual({
      kind: "failed",
      failedAt: "read",
      reason: stallReason(r.folder),
    });
    // A stall is not a loss: the generation is still the right one.
    r.open();
    expect(r.generation()).toBe(0);
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
      failedAt: "read",
      reason: `cannot refresh: ${r.folder} ${r.folder}: EIO: i/o error; retried at the next file-event period or catch-up`,
    });
    expect(r.storage.stats()).toMatchObject({
      faults: { unusable: 0, refused: 0, error: 1 },
    });
  });

  // The event naming the folder and the follower's event that reloads its
  // config ride one stream, which can drop both at once without a stall.
  test("a folder replaced while its own event was dropped is lost on the next period, and the period after is a new generation", async () => {
    fakeWatches();
    const r = rig();
    r.open();
    r.write(A, '"a"');
    const lane = r.storage.declare(new Holds(), r.folder, A);
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
    r.fileEvents.notify({ kind: "period" });
    expect(r.generation()).toBe(1);
  });

  test("a folder removed under its watch is lost once, however many periods pass", async () => {
    fakeWatches();
    const r = rig();
    r.open();
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
      failedAt: "read",
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

  test("a refused watch's generation opens again once file events catch up, with no declaration", async () => {
    const r = rig();
    fakeWatches(new Set([r.folder]));
    r.open();
    expect(r.storage.stats().faults).toMatchObject({ refused: 1 });
    jest.restoreAllMocks();
    fakeWatches();
    r.fileEvents.set(delivering, { kind: "caught-up", since: STALLED_AT });
    expect(r.generation()).toBe(1);
  });

  test("a period with delivery unchanged re-reads nothing", async () => {
    fakeWatches();
    const r = rig();
    r.open();
    r.write(A, '"a"');
    const lane = r.storage.declare(new Holds(), r.folder, A);
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
    fs.mkdirSync(r.folder);
    for (const sid of ["old", "held-old", "young"]) r.write(sid, "{}");
    fs.writeFileSync(path.join(r.folder, "old-notes.txt"), "");
    age(path.join(r.folder, "old.json"), 31);
    age(path.join(r.folder, "held-old.json"), 31);
    age(path.join(r.folder, "old-notes.txt"), 31);
    // The declaration opens the folder's watch, whose opening sweeps.
    await answered(
      r.storage.declare(new Holds(), r.folder, sessionIdOf("held-old")),
    );
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
    fs.mkdirSync(r.folder);
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
    r.open();
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
    r.open();
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
    expect(r.lines.filter((l) => l.includes("sweep")).at(-1)).toMatch(
      /scanned=1 removed=1 /,
    );
    expect(fs.existsSync(path.join(r.folder, "session-a.json"))).toBe(false);
  });
});
