import { processLauncher } from "../src/proc/launch";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  WatcherRegistry,
  watchFault,
  watchTargetsOf,
  type Deafness,
  type Invalidation,
} from "../src/daemon/cache/watchers";
import { GitDataProvider } from "../src/daemon/cache/git";
import { GitService, type GitInfo } from "../src/segments/git";
import { ok, type Outcome } from "../src/utils/outcome";
import { Holds } from "../src/utils/holds";
import { until } from "./helpers/until";
import { untilHeard } from "./helpers/reload-signal";
import { laneOutcome } from "../src/utils/reading";

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "powerline-watch-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@t.t && git config user.name t", {
    cwd: dir,
  });
  fs.writeFileSync(path.join(dir, "f"), "x");
  execSync("git add . && git commit -q -m init", { cwd: dir });
  return dir;
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("WatcherRegistry", () => {
  // fs.watch has no ready signal (on macOS the FSEvents stream goes live
  // after the call returns), so the write is re-applied until an event
  // proves the watch was live — the only proof there is — never written once
  // after a sleep that bets on it.
  test("a write to a watched name fires invalidation", async () => {
    const repo = makeRepo();
    const reg = new WatcherRegistry();
    let fired = 0;
    const headPath = path.join(repo, ".git/HEAD");
    reg.acquire(
      repo,
      { dirs: [{ path: path.dirname(headPath), filenames: ["HEAD"] }] },
      () => fired++,
    );
    try {
      await untilHeard(
        () => fs.writeFileSync(headPath, "ref: refs/heads/x\n"),
        () => fired >= 1,
        "HEAD write fired the watch",
      );
    } finally {
      reg.closeAll();
      rmrf(repo);
    }
  });

  test("refcount: release closes watchers when refcount hits zero", async () => {
    const repo = makeRepo();
    const reg = new WatcherRegistry();
    const h1 = reg.acquire(repo, { dirs: [] }, () => {});
    const h2 = reg.acquire(repo, { dirs: [] }, () => {});
    expect(reg.size()).toBe(1);
    h1.release();
    expect(reg.size()).toBe(1); // refcount still > 0
    h2.release();
    expect(reg.size()).toBe(0);
    rmrf(repo);
  });

  // The one rule for a watch whose targets move: the held watch follows the
  // spec exactly when the key differs, so every consumer rebinds the same way.
  test("follow keeps a watch under the same key and rebinds it under a new one", () => {
    const counters = {
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 0,
      watchErrors: 0,
      dirWatchesOpened: 0,
      dirWatchesClosed: 0,
    };
    const reg = new WatcherRegistry({ counters });
    const first = reg.follow(
      null,
      { key: "a", targets: { dirs: [] }, unbound: false },
      () => {},
    );
    expect(first.move).toBe("rebound");
    expect(first.watch.key).toBe("a");

    const kept = reg.follow(
      first.watch,
      { key: "a", targets: { dirs: [] }, unbound: false },
      () => {},
    );
    expect(kept.move).toBe("kept");
    expect(kept.watch).toBe(first.watch);
    expect(reg.size()).toBe(1);

    const rebound = reg.follow(
      kept.watch,
      { key: "b", targets: { dirs: [] }, unbound: false },
      () => {},
    );
    expect(rebound.move).toBe("rebound");
    expect(rebound.watch.key).toBe("b");

    // A spec naming a directory that binds nothing yet keeps the watch held,
    // whatever its key: the derive that finds the directory there rebinds.
    const unbound = reg.follow(
      rebound.watch,
      { key: "c", targets: { dirs: [] }, unbound: true },
      () => {},
    );
    expect(unbound.move).toBe("kept");
    expect(unbound.watch).toBe(rebound.watch);
    // The watch under the old key is released; one slot is held, the new one.
    expect(reg.size()).toBe(1);
    expect(counters).toEqual({
      watchersOpened: 2,
      watchersClosed: 1,
      watchRefusals: 0,
      watchErrors: 0,
      dirWatchesOpened: 0,
      dirWatchesClosed: 0,
    });
    reg.closeAll();
  });

  // brandon-unfiled-3248.576q: the registry bounds nothing — its consumers do.
  // An LRU cap here closed watches under holders that still held them.
  test("a slot closes only when its last holder releases it, however many are open", () => {
    const counters = {
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 0,
      watchErrors: 0,
      dirWatchesOpened: 0,
      dirWatchesClosed: 0,
    };
    const reg = new WatcherRegistry({ counters });
    const fired: string[] = [];
    const handles = Array.from({ length: 300 }, (_, i) =>
      reg.acquire(`k${i}`, { dirs: [] }, () => fired.push(`k${i}`)),
    );

    expect(reg.size()).toBe(300);
    expect(counters).toEqual({
      watchersOpened: 300,
      watchersClosed: 0,
      watchRefusals: 0,
      watchErrors: 0,
      dirWatchesOpened: 0,
      dirWatchesClosed: 0,
    });
    expect(fired).toEqual([]);

    handles[0]!.release();
    expect(reg.size()).toBe(299);
    expect(counters.watchersClosed).toBe(1);
    reg.closeAll();
  });

  test("hands its consumer the paths that fired in the window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-names-"));
    const reg = new WatcherRegistry();
    const seen: Invalidation[] = [];
    reg.acquire(dir, { dirs: [{ path: dir }] }, (inv) => seen.push(inv));
    // FSEvents may also report the folder's own creation late, under its
    // name: the paths are what fired, whatever else did.
    const paths = () =>
      seen.flatMap((inv) => (inv.kind === "changed" ? [...inv.paths] : []));
    const [a, b] = ["a.json", "b.json"].map((f) => path.join(dir, f));
    try {
      await untilHeard(
        () => {
          fs.writeFileSync(a!, "1");
          fs.writeFileSync(b!, "2");
        },
        () => paths().includes(a!) && paths().includes(b!),
        "both files' paths",
      );
      expect(seen.every((inv) => inv.kind === "changed")).toBe(true);
    } finally {
      reg.closeAll();
      rmrf(dir);
    }
  });

  test("a tree target hears a write below its first level, named by its path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-tree-"));
    const reg = new WatcherRegistry();
    const seen: Invalidation[] = [];
    reg.acquire(dir, { dirs: [{ path: dir, recursive: true }] }, (inv) =>
      seen.push(inv),
    );
    const paths = () =>
      seen.flatMap((inv) => (inv.kind === "changed" ? [...inv.paths] : []));
    const leaf = path.join(dir, "a", "b", "c");
    // The directories appear under the live watch, as a branch's `fix/`
    // directory appears under a repo's watch, and the leaf's write is
    // re-applied until the watch proves itself live on it.
    fs.mkdirSync(path.dirname(leaf), { recursive: true });
    try {
      await untilHeard(
        () => fs.writeFileSync(leaf, "1"),
        () => paths().includes(leaf),
        () => `the leaf's path among ${JSON.stringify(paths())}`,
      );
    } finally {
      reg.closeAll();
      rmrf(dir);
    }
  });

  test("a refused target comes back on the handle and in the stats, never as opened", () => {
    const counters = {
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 0,
      watchErrors: 0,
      dirWatchesOpened: 0,
      dirWatchesClosed: 0,
    };
    const reg = new WatcherRegistry({ counters, logger: () => {} });
    const missing = path.join(os.tmpdir(), "watch-refused-no-such-folder");
    const handle = reg.acquire("k", { dirs: [{ path: missing }] }, () => {});
    expect(handle.deaf).toEqual([
      {
        kind: "refused",
        path: missing,
        reason: expect.stringContaining("ENOENT"),
      },
    ]);
    // A second holder of the slot is told the same.
    expect(reg.acquire("k", { dirs: [] }, () => {}).deaf).toEqual(
      handle.deaf,
    );
    expect(counters).toEqual({
      watchersOpened: 0,
      watchersClosed: 0,
      watchRefusals: 1,
      watchErrors: 0,
      dirWatchesOpened: 0,
      dirWatchesClosed: 0,
    });
    // Its release is counted like any slot's: opened plus refusals less
    // closed is what is held now.
    reg.closeAll();
    expect(counters.watchersClosed).toBe(1);
  });

  // fs.watch refuses a folder it cannot read, except Linux's recursive watch
  // on Node 20 and 22, which swallows the error and never fires. The registry
  // refuses it on every platform and Node, as a tree or not. Root ignores
  // directory permissions, so the condition cannot be built.
  (process.getuid?.() === 0 ? test.skip : test)(
    "a folder the daemon cannot open is refused, watched as a tree or not",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-unreadable-"));
      fs.chmodSync(dir, 0o000);
      const reg = new WatcherRegistry({ logger: () => {} });
      try {
        const refusal = {
          kind: "refused",
          path: dir,
          reason: expect.stringContaining("EACCES"),
        };
        expect(reg.acquire("dir", { dirs: [{ path: dir }] }, () => {}).deaf)
          .toEqual([refusal]);
        expect(
          reg.acquire("tree", { dirs: [{ path: dir, recursive: true }] }, () => {})
            .deaf,
        ).toEqual([refusal]);
        expect(reg.dirWatches()).toBe(0);
      } finally {
        reg.closeAll();
        fs.chmodSync(dir, 0o700);
        rmrf(dir);
      }
    },
  );

  test("an error after open reaches the consumer and the stats", async () => {
    const fake = standIn();
    try {
      const counters = zeroCounters();
      const reg = new WatcherRegistry({ counters, logger: () => {} });
      const seen: Invalidation[] = [];
      reg.acquire("k", { dirs: [{ path: "/w" }] }, (inv) => seen.push(inv));
      fake.opensOf("/w")[0]!.handle.emit(
        "error",
        new Error("EMFILE: too many open files"),
      );
      await until(() => seen.length > 0, "the error's invalidation");
      expect(seen).toEqual([
        { kind: "failed", reason: "/w: EMFILE: too many open files" },
      ]);
      expect(counters).toMatchObject({
        watchersOpened: 1,
        watchErrors: 1,
        // The handle that errored is closed, so no directory watch is held.
        dirWatchesOpened: 1,
        dirWatchesClosed: 1,
      });
      reg.closeAll();
    } finally {
      fake.restore();
    }
  });

  // A stand-in for the OS's side of a watch the test drives: every directory
  // opens, and every handle fs.watch opens is recorded with the directory, the
  // listener the registry gave it, and whether it was closed. No real
  // directory can be made to report or fail on demand.
  function standIn() {
    type Opened = {
      dir: string;
      closed: boolean;
      listener: (event: string, changed: string | null) => void;
      handle: EventEmitter;
    };
    const opened: Opened[] = [];
    const watch = jest.spyOn(fs, "watch").mockImplementation(((
      dir: string,
      _opts: unknown,
      listener: Opened["listener"],
    ) => {
      const record = { dir, closed: false, listener } as Opened;
      record.handle = Object.assign(new EventEmitter(), {
        close: () => void (record.closed = true),
      });
      opened.push(record);
      return record.handle;
    }) as unknown as typeof fs.watch);
    const opendir = jest
      .spyOn(fs, "opendirSync")
      .mockImplementation(
        (() => ({ closeSync: () => {} })) as unknown as typeof fs.opendirSync,
      );
    const opensOf = (dir: string) => opened.filter((o) => o.dir === dir);
    return {
      opened,
      opensOf,
      restore: () => {
        watch.mockRestore();
        opendir.mockRestore();
      },
    };
  }

  const zeroCounters = () => ({
    watchersOpened: 0,
    watchersClosed: 0,
    watchRefusals: 0,
    watchErrors: 0,
    dirWatchesOpened: 0,
    dirWatchesClosed: 0,
  });

  // The OS reports a watched directory's own removal or rename under its own
  // name, which no name filter lists; without it, a watch bound to a removed
  // directory never tells its consumer to derive the watch again. The same
  // name with the folder still there (macOS reporting a child that came or
  // went) is not the directory's removal.
  test("a name-filtered directory hears its own removal, and not its own name while it is still there", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-self-"));
    const conf = path.join(root, "conf");
    fs.mkdirSync(conf);
    const fake = standIn();
    try {
      const reg = new WatcherRegistry({ logger: () => {} });
      const seen: Invalidation[] = [];
      reg.acquire("k", { dirs: [{ path: conf, filenames: ["config.json5"] }] }, (inv) => seen.push(inv));
      const { listener } = fake.opensOf(conf)[0]!;
      listener("change", "conf");
      listener("rename", "config.json5");
      await until(() => seen.length === 1, "the watched name's invalidation");
      // macOS reports the removal as a change.
      fs.rmSync(conf, { recursive: true });
      listener("change", "conf");
      await until(() => seen.length === 2, "the removal's invalidation");
      expect(seen).toEqual([
        { kind: "changed", paths: new Set([path.join(conf, "config.json5")]) },
        { kind: "changed", paths: new Set([path.join(conf, "conf")]) },
      ]);
      reg.closeAll();
    } finally {
      fake.restore();
      rmrf(root);
    }
  });

  // The handle moves onto the folder made again, so a later event naming the
  // directory (macOS: a child came or went) is judged against that folder and
  // passes no filter; every slot on it re-reads what went unheard.
  test("a name-filtered directory hears its own name when the folder at its path is replaced, moves onto the new folder, and not after a chmod", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-self-"));
    const conf = path.join(root, "conf");
    fs.mkdirSync(conf);
    const fake = standIn();
    try {
      const reg = new WatcherRegistry({ logger: () => {} });
      const seen: Invalidation[] = [];
      reg.acquire("k", { dirs: [{ path: conf, filenames: ["config.json5"] }] }, (inv) => seen.push(inv));
      const { listener } = fake.opensOf(conf)[0]!;
      fs.chmodSync(conf, 0o755);
      listener("change", "conf");
      fs.renameSync(conf, path.join(root, "old"));
      fs.mkdirSync(conf);
      listener("rename", "conf");
      await until(() => seen.length === 1, "the replacement's invalidation");
      expect(seen).toEqual([{ kind: "unknown" }]);
      expect(fake.opensOf(conf)).toHaveLength(2);
      expect(fake.opensOf(conf)[0]!.closed).toBe(true);
      fake.opensOf(conf)[1]!.listener("change", "conf");
      fake.opensOf(conf)[1]!.listener("rename", "config.json5");
      await until(() => seen.length === 2, "the watched name's invalidation");
      expect(seen[1]).toEqual({
        kind: "changed",
        paths: new Set([path.join(conf, "config.json5")]),
      });
      reg.closeAll();
    } finally {
      fake.restore();
      rmrf(root);
    }
  });

  // A platform that names nothing may be reporting the filtered child.
  test("an unnamed event under a name filter is unknown", async () => {
    const fake = standIn();
    try {
      const reg = new WatcherRegistry({ logger: () => {} });
      const seen: Invalidation[] = [];
      reg.acquire("k", { dirs: [{ path: "/w", filenames: ["a"] }] }, (inv) => seen.push(inv));
      fake.opensOf("/w")[0]!.listener("rename", null);
      await until(() => seen.length === 1, "the unnamed event's invalidation");
      expect(seen).toEqual([{ kind: "unknown" }]);
      reg.closeAll();
    } finally {
      fake.restore();
    }
  });

  test("every holder of a key hears each window", async () => {
    const fake = standIn();
    try {
      const reg = new WatcherRegistry({ logger: () => {} });
      const first: Invalidation[] = [];
      const second: Invalidation[] = [];
      reg.acquire("k", { dirs: [{ path: "/w" }] }, (inv) => first.push(inv));
      reg.acquire("k", { dirs: [{ path: "/w" }] }, (inv) => second.push(inv));
      expect(fake.opened).toHaveLength(1);
      fake.opensOf("/w")[0]!.listener("rename", "a");
      await until(() => first.length === 1 && second.length === 1, "both holders' windows");
      expect(second).toEqual(first);
      reg.closeAll();
    } finally {
      fake.restore();
    }
  });

  // On macOS every open or close of a directory watch rebuilds the daemon's
  // one FSEvents stream, so slots share one handle per directory.
  test("slots on one directory share one handle, which closes with the last of them", () => {
    const fake = standIn();
    try {
      const counters = zeroCounters();
      const reg = new WatcherRegistry({ counters, logger: () => {} });
      const a = reg.acquire("a", { dirs: [{ path: "/w", filenames: ["x"] }] }, () => {});
      const b = reg.acquire("b", { dirs: [{ path: "/w", filenames: ["y"] }] }, () => {});
      expect(fake.opened).toHaveLength(1);
      expect(reg.dirWatches()).toBe(1);
      a.release();
      expect(fake.opened[0]!.closed).toBe(false);
      b.release();
      expect(fake.opened[0]!.closed).toBe(true);
      expect(counters).toEqual({
        ...zeroCounters(),
        watchersOpened: 2,
        watchersClosed: 2,
        dirWatchesOpened: 1,
        dirWatchesClosed: 1,
      });
      expect(reg.dirWatches()).toBe(0);
    } finally {
      fake.restore();
    }
  });

  // A link re-pointed to a new name beside the old one moves the key (it
  // spells the name filters) and nothing the OS holds.
  test("following to a key that changes only a name filter opens and closes no handle, and hears the new name", async () => {
    const fake = standIn();
    try {
      const reg = new WatcherRegistry({ logger: () => {} });
      const seen: Invalidation[] = [];
      const spec = (name: string) => ({
        key: `k:${name}`,
        targets: { dirs: [{ path: "/w", filenames: [name] }] },
        unbound: false,
      });
      const first = reg.follow(null, spec("a"), (inv) => seen.push(inv));
      const moved = reg.follow(first.watch, spec("b"), (inv) => seen.push(inv));
      expect(moved.move).toBe("rebound");
      expect(fake.opened).toHaveLength(1);
      expect(fake.opened[0]!.closed).toBe(false);
      fake.opened[0]!.listener("rename", "a");
      fake.opened[0]!.listener("rename", "b");
      await until(() => seen.length === 1, "the new name's invalidation");
      expect(seen).toEqual([{ kind: "changed", paths: new Set(["/w/b"]) }]);
      reg.closeAll();
    } finally {
      fake.restore();
    }
  });

  // Linux's inotify follows the inode, so a handle on a directory removed and
  // made again at its path hears nothing more; a slot naming the directory as
  // it is now moves the handle onto it, for every slot on it.
  test("a directory made again at its path is reopened in place when a slot acquires it, and kept while its path is empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-again-"));
    const dir = path.join(root, "d");
    fs.mkdirSync(dir);
    const fake = standIn();
    try {
      const reg = new WatcherRegistry({ logger: () => {} });
      reg.acquire("a", { dirs: [{ path: dir }] }, () => {});
      fs.rmSync(dir, { recursive: true });
      reg.acquire("b", { dirs: [{ path: dir }] }, () => {});
      expect(fake.opensOf(dir)).toHaveLength(1);
      expect(fake.opensOf(dir)[0]!.closed).toBe(false);
      fs.mkdirSync(dir);
      reg.acquire("c", { dirs: [{ path: dir }] }, () => {});
      expect(fake.opensOf(dir)).toHaveLength(2);
      expect(fake.opensOf(dir)[0]!.closed).toBe(true);
      expect(reg.dirWatches()).toBe(1);
      reg.closeAll();
    } finally {
      fake.restore();
      rmrf(root);
    }
  });

  // A strict ancestor renamed away and another tree put at its path reports
  // nothing to the handle: inotify reports a directory's own removal or
  // self-move, never its parent's, so the handle stays listening, bound to a
  // folder no longer at its path. The period's judgment is the one trigger
  // that reaches it; a folder unchanged or gone is left alone.
  test("a directory whose strict ancestor is replaced by rename is reopened by the period's judgment, and its slot hears what went unheard", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-ancestor-"));
    const conf = path.join(root, "proj", "conf");
    fs.mkdirSync(conf, { recursive: true });
    const fake = standIn();
    try {
      const counters = zeroCounters();
      const reg = new WatcherRegistry({ counters, logger: () => {} });
      const seen: Invalidation[] = [];
      reg.acquire("k", { dirs: [{ path: conf, filenames: ["config.json5"] }] }, (inv) => seen.push(inv));
      reg.judge();
      fs.renameSync(path.join(root, "proj"), path.join(root, "old"));
      reg.judge();
      expect(fake.opensOf(conf)).toHaveLength(1);
      expect(fake.opensOf(conf)[0]!.closed).toBe(false);
      fs.mkdirSync(conf, { recursive: true });
      reg.judge();
      expect(fake.opensOf(conf)).toHaveLength(2);
      expect(fake.opensOf(conf)[0]!.closed).toBe(true);
      await until(() => seen.length === 1, "the reopen's window");
      expect(seen).toEqual([{ kind: "unknown" }]);
      // Bound to the folder there now: judged again, nothing reopens.
      reg.judge();
      expect(fake.opensOf(conf)).toHaveLength(2);
      fake.opensOf(conf)[1]!.listener("rename", "config.json5");
      await until(() => seen.length === 2, "the watched name's window");
      expect(seen[1]).toEqual({
        kind: "changed",
        paths: new Set([path.join(conf, "config.json5")]),
      });
      expect(counters).toEqual({
        ...zeroCounters(),
        watchersOpened: 1,
        dirWatchesOpened: 2,
        dirWatchesClosed: 1,
      });
      reg.closeAll();
    } finally {
      fake.restore();
      rmrf(root);
    }
  });

  // A failed directory is the period's to retry and nobody else's: config,
  // git and watch_file sources follow on the failed window its handle told,
  // and a follow that retried would retry an error that recurs on every
  // reopen at the debounce cadence.
  test("a directory whose handle errors is deaf to every slot on it until the period's judgment reopens it alone; a kept follow opens nothing", async () => {
    const fake = standIn();
    try {
      const counters = zeroCounters();
      const reg = new WatcherRegistry({ counters, logger: () => {} });
      const spec = {
        key: "k",
        targets: { dirs: [{ path: "/w" }, { path: "/v" }] },
        unbound: false,
      };
      const seen: Invalidation[] = [];
      const other: Invalidation[] = [];
      const { watch } = reg.follow(null, spec, (inv) => seen.push(inv));
      reg.acquire("other", { dirs: [{ path: "/w" }] }, (inv) => other.push(inv));
      fake.opensOf("/w")[0]!.handle.emit("error", new Error("EMFILE: too many open files"));
      await until(() => seen.length === 1 && other.length === 1, "both slots' failed windows");
      expect(other).toEqual([{ kind: "failed", reason: "/w: EMFILE: too many open files" }]);
      expect(watch.handle.deaf).toEqual([
        { kind: "failed", path: "/w", reason: "EMFILE: too many open files" },
      ]);

      // The follow answering the failed window keeps the watch as it is.
      expect(reg.follow(watch, spec, () => {}).move).toBe("kept");
      expect(fake.opensOf("/w")).toHaveLength(1);

      reg.judge();
      expect(fake.opensOf("/w")).toHaveLength(2);
      expect(fake.opensOf("/v")).toHaveLength(1);
      expect(fake.opensOf("/v")[0]!.closed).toBe(false);
      expect(watch.handle.deaf).toEqual([]);
      // Every slot on it hears the recovery, so the fault each reported clears.
      await until(() => seen.length === 2 && other.length === 2, "both slots' recovery windows");
      expect(seen[1]).toEqual({ kind: "unknown" });
      expect(other[1]).toEqual({ kind: "unknown" });
      expect(counters).toEqual({
        ...zeroCounters(),
        watchersOpened: 2,
        watchErrors: 1,
        dirWatchesOpened: 3,
        dirWatchesClosed: 1,
      });
      reg.closeAll();
    } finally {
      fake.restore();
    }
  });

  // A reopen replaces the handle; an error or event still on its way from
  // the closed one speaks for no directory.
  test("an error or event from a handle a reopen replaced changes nothing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-stale-"));
    const dir = path.join(root, "d");
    fs.mkdirSync(dir);
    const fake = standIn();
    try {
      const counters = zeroCounters();
      const reg = new WatcherRegistry({ counters, logger: () => {} });
      const seen: Invalidation[] = [];
      const a = reg.acquire("a", { dirs: [{ path: dir, filenames: ["x"] }] }, (inv) => seen.push(inv));
      fs.rmSync(dir, { recursive: true });
      fs.mkdirSync(dir);
      reg.acquire("b", { dirs: [{ path: dir }] }, () => {});
      await until(() => seen.length === 1, "the reopen's window");
      const [stale, current] = fake.opensOf(dir);
      stale!.handle.emit("error", new Error("EBADF: bad file descriptor"));
      stale!.listener("rename", "x");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(seen).toEqual([{ kind: "unknown" }]);
      expect(a.deaf).toEqual([]);
      expect(current!.closed).toBe(false);
      expect(reg.dirWatches()).toBe(1);
      expect(counters.dirWatchesClosed).toBe(1);
      reg.closeAll();
    } finally {
      fake.restore();
      rmrf(root);
    }
  });

  // Every acquire names its directories as they are now: a holder joining a
  // slot retries its deaf directory as one opening a slot does.
  test("acquiring a slot another holder holds reopens its deaf directory", () => {
    const fake = standIn();
    try {
      const reg = new WatcherRegistry({ logger: () => {} });
      const first = reg.acquire("k", { dirs: [{ path: "/w" }] }, () => {});
      fake.opensOf("/w")[0]!.handle.emit("error", new Error("EMFILE: too many open files"));
      expect(first.deaf).toHaveLength(1);
      const second = reg.acquire("k", { dirs: [{ path: "/w" }] }, () => {});
      expect(fake.opensOf("/w")).toHaveLength(2);
      expect(second.deaf).toEqual([]);
      expect(first.deaf).toEqual([]);
      reg.closeAll();
    } finally {
      fake.restore();
    }
  });

  test("closeAll closes every watcher", () => {
    const repo = makeRepo();
    const reg = new WatcherRegistry();
    reg.acquire(repo, { dirs: [] }, () => {});
    expect(reg.size()).toBe(1);
    reg.closeAll();
    expect(reg.size()).toBe(0);
    rmrf(repo);
  });
});

class StubInner extends GitService {
  public calls = 0;
  constructor(private repo: string) {
    super(processLauncher);
  }
  override findGitRoot(): Outcome<string> {
    return ok(this.repo);
  }
  override async getGitInfo(): Promise<Outcome<GitInfo>> {
    this.calls++;
    return ok({
      branch: "main",
      status: "clean",
      aheadBehind: ok({ ahead: 0, behind: 0 }),
      head: ok("c0ffee"),
    });
  }
}

const sha = (ref: string, cwd: string): string =>
  execSync(`git rev-parse ${ref}`, { cwd, encoding: "utf8" }).trim();

// A ref-only move — nothing but the branch's ref rewritten, no HEAD, no index
// — on a slash-named branch checked out in `workingDir`, heard by the repo's
// watch with no read asking, until the stored head is the ref's.
//
// The branch is cut only once the watch has proven itself live, because that
// is the order a session meets: its repo is declared long before a branch is
// cut, so `refs/heads/fix/` appears under a watch already open. On Linux the
// tree watch has to pick a new directory up itself; a watch opened over an
// existing one proves nothing about that.
async function hearsRefOnlyMove(
  workingDir: string,
  branch: string,
): Promise<void> {
  // The real reader: what it stores is what git reads off the repo, so the
  // test can ask whether the value is the ref's after a move.
  const inner = new GitService(processLauncher);
  const svc = new GitDataProvider({ inner, periodMs: 600_000 });
  const lane = svc.declare(new Holds(), workingDir, {});
  await laneOutcome(lane);
  const storedHead = (): string | undefined => {
    const info = lane.current();
    return info.kind === "ok" && info.value.head.kind === "ok"
      ? info.value.head.value
      : undefined;
  };
  try {
    // fs.watch has no ready signal: HEAD is rewritten, unchanged, until the
    // watch fires a change, which only the watch can raise. Written as git
    // writes it, a `.lock` renamed over it, so a read mid-rewrite never sees
    // an empty HEAD.
    const headPath = path.join(inner.resolveGitDir(workingDir), "HEAD");
    const head = fs.readFileSync(headPath, "utf8");
    await untilHeard(
      () => {
        fs.writeFileSync(`${headPath}.lock`, head);
        fs.renameSync(`${headPath}.lock`, headPath);
      },
      () => svc.getStats().changes >= 1,
      "the HEAD rewrite's change",
    );

    execSync(`git checkout -q -b ${branch}`, { cwd: workingDir });
    const tip = sha("HEAD", workingDir);
    const parent = sha("HEAD~1", workingDir);
    // The move alternates the ref between the two commits so that every
    // re-application is a write; a same-value update-ref touches nothing.
    const seen = new Set<string>();
    let atParent = false;
    await untilHeard(
      () => {
        atParent = !atParent;
        execSync(
          `git update-ref refs/heads/${branch} ${atParent ? parent : tip}`,
          { cwd: workingDir },
        );
      },
      () => {
        const now = storedHead();
        if (now !== undefined) seen.add(now);
        return seen.has(parent);
      },
      "a re-read storing the moved ref's head",
    );
    // A change mid-read queues one re-read after it, so the last move lands.
    await until(
      () => storedHead() === sha(branch, workingDir),
      () => `the last move's head; stored ${storedHead()}`,
    );
  } finally {
    svc.close();
  }
}

describe("watchTargetsOf", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-targets-")));
  });
  afterEach(() => rmrf(dir));

  test("a chain the kernel stops walking is watched as far as it got, and says why", () => {
    // one/x → two/y → one/x: a loop across two directories.
    for (const d of ["one", "two"]) fs.mkdirSync(path.join(dir, d));
    const x = path.join(dir, "one", "x");
    const y = path.join(dir, "two", "y");
    fs.symlinkSync(y, x);
    fs.symlinkSync(x, y);
    const { targets, reached, unresolved } = watchTargetsOf({ named: [x], whole: [] });
    expect(targets.dirs).toEqual([
      { path: path.join(dir, "one"), filenames: ["x"] },
      { path: path.join(dir, "two"), filenames: ["y"] },
    ]);
    expect(reached).toBe(true);
    expect(unresolved).toEqual([{ path: x, reason: expect.stringMatching(/symbolic links/) }]);
  });

  // A held watch binds the inode it opened on (Linux's inotify), so the same
  // directories by the same names are a different watch once one is made
  // again at its path: a consumer following the key rebinds onto it.
  test("a directory removed and made again at its path is a different watch", () => {
    const d = path.join(dir, "d");
    fs.mkdirSync(d);
    const f = path.join(d, "f");
    const before = watchTargetsOf({ named: [f], whole: [] });
    expect(watchTargetsOf({ named: [f], whole: [] }).key).toBe(before.key);
    rmrf(d);
    fs.mkdirSync(d);
    const after = watchTargetsOf({ named: [f], whole: [] });
    expect(after.targets).toEqual(before.targets);
    expect(after.key).not.toBe(before.key);
  });

  test("a directory watched whole hears every child, whatever names are watched in it", () => {
    const d = path.join(dir, "d");
    fs.mkdirSync(d);
    const { targets } = watchTargetsOf({ named: [d, path.join(d, "f")], whole: [d] });
    expect(targets.dirs).toEqual([
      { path: dir, filenames: ["d"] },
      { path: d },
    ]);
  });

  test("a hop under a directory that does not exist yet has not reached it", () => {
    const { targets, reached } = watchTargetsOf({ named: [path.join(dir, "later", "f")], whole: [] });
    expect(targets.dirs).toEqual([{ path: dir, filenames: ["later"] }]);
    expect(reached).toBe(false);
  });
});

// What a watch says it cannot hear, from the watch alone: the bar shows this
// for a config and for a `watch_file` path alike.
describe("watchFault", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-fault-")));
  });
  afterEach(() => rmrf(dir));

  const held = (deaf: readonly Deafness[]) => ({
    key: "k",
    handle: { release: () => {}, deaf },
  });

  test("a watch that hears every place its paths can change has no fault", () => {
    const derived = watchTargetsOf({ named: [path.join(dir, "f")], whole: [] });
    expect(watchFault("config", { derived, held: held([]) }, null)).toBeNull();
  });

  test("names each path whose links it cannot follow, and each directory the OS is not listening to", () => {
    const x = path.join(dir, "x");
    fs.symlinkSync(`${x}.other`, x);
    fs.symlinkSync(x, `${x}.other`);
    const derived = watchTargetsOf({ named: [x, path.join(dir, "f")], whole: [] });
    const fault = watchFault("config", {
      derived,
      held: held([
        { kind: "refused", path: "/r", reason: "EMFILE" },
        { kind: "failed", path: "/f", reason: "gone" },
      ]),
    }, null);
    expect(fault).toContain(`config: cannot follow a link chain — ${x}: more than 40 symbolic links`);
    expect(fault).toContain("; cannot watch /r — EMFILE; watching /f failed — gone");
  });

  test("a reason beyond the watch's own is the watch's fault too", () => {
    const derived = watchTargetsOf({ named: [path.join(dir, "f")], whole: [] });
    expect(watchFault("config", { derived, held: held([]) }, "the OS stopped")).toBe("config: the OS stopped");
    expect(
      watchFault(
        "config",
        { derived, held: held([{ kind: "refused", path: "/r", reason: "EMFILE" }]) },
        "the OS stopped",
      ),
    ).toBe("config: cannot watch /r — EMFILE; the OS stopped");
  });
});

describe("GitDataProvider + watchers integration", () => {
  test("a ref-only move on a slash-named branch is heard in a main checkout (brandon-unfiled-3248.1x2q)", async () => {
    const repo = makeRepo();
    execSync("git commit -q --allow-empty -m second", { cwd: repo });
    try {
      await hearsRefOnlyMove(repo, "fix/thing");
    } finally {
      rmrf(repo);
    }
  });

  test("a ref-only move on a slash-named branch is heard in a linked worktree, whose own git dir holds no refs (brandon-unfiled-3248.1x2q)", async () => {
    const repo = makeRepo();
    execSync("git commit -q --allow-empty -m second", { cwd: repo });
    const worktree = path.join(repo, "..", path.basename(repo) + "-wt");
    execSync(`git worktree add -q "${worktree}"`, { cwd: repo });
    try {
      await hearsRefOnlyMove(worktree, "feat/thing");
    } finally {
      rmrf(worktree);
      rmrf(repo);
    }
  });

  test("a HEAD change re-reads the repo with no read asking", async () => {
    const repo = makeRepo();
    const inner = new StubInner(repo);
    const svc = new GitDataProvider({ inner });
    const holds = new Holds();
    try {
      await laneOutcome(svc.declare(holds, repo, {}));
      await laneOutcome(svc.declare(holds, repo, {}));
      expect(inner.calls).toBe(1);

      // HEAD is rewritten until the watch proves itself live by a change and
      // its re-read: a write before FSEvents goes live is never reported.
      // Every rewrite the watch hears is a change, and one mid-read queues a
      // re-read after it, so the count is at least one more. The change is
      // part of the condition so a period's re-read cannot stand in for it.
      await untilHeard(
        () =>
          fs.writeFileSync(path.join(repo, ".git/HEAD"), "ref: refs/heads/y\n"),
        () => svc.getStats().changes >= 1 && inner.calls >= 2,
        "the HEAD change's re-read",
      );
      // The read takes the value the change's re-read stored: a hit, never a
      // miss that waits on a read. The reader's count is not the measure
      // here, because a re-read a late event queued may begin on any turn.
      const { hits, misses } = svc.getStats();
      await laneOutcome(svc.declare(holds, repo, {}));
      expect(svc.getStats()).toMatchObject({ hits: hits + 1, misses });
    } finally {
      svc.close();
      rmrf(repo);
    }
  });

  test("a held repo is re-read on its period, which a dropped watch event cannot stop", async () => {
    const repo = makeRepo();
    const inner = new StubInner(repo);
    const svc = new GitDataProvider({ inner, periodMs: 150 });
    const holds = new Holds();

    await laneOutcome(svc.declare(holds, repo, {}));
    expect(inner.calls).toBe(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(inner.calls).toBeGreaterThanOrEqual(3);

    // Released, the repo costs no read on the period.
    holds.declare(() => {});
    const after = inner.calls;
    await new Promise((r) => setTimeout(r, 400));
    expect(inner.calls).toBe(after);
    svc.close();
    rmrf(repo);
  });

  test("close releases all watchers", async () => {
    const repo = makeRepo();
    const inner = new StubInner(repo);
    const svc = new GitDataProvider({ inner });
    await laneOutcome(svc.declare(new Holds(), repo, {}));
    expect(svc.getStats().watchers).toBe(1);
    svc.close();
    expect(svc.getStats().watchers).toBe(0);
    rmrf(repo);
  });
});
