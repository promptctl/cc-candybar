// [LAW:behavior-not-structure] The watcher registry over the filesystem fake:
// what a holder hears when files, folders and links change, with no disk and
// no real time. The fake stands for both platforms the registry judges.

import {
  DEBOUNCE_MS,
  NAMES_POLL_MS,
  WatcherRegistry,
  watchTargetsOf,
  type Invalidation,
} from "../../src/daemon/cache/watchers";
import {
  filesystemFake,
  type FilesystemFake,
} from "../../src/disk/filesystem-fake";
import { heldClock, type HeldClock } from "../helpers/held-clock";

for (const platform of ["darwin", "linux"] as const) {
  describe(`the watcher registry over the ${platform} fake`, () => {
    let clock: HeldClock;
    let disk: FilesystemFake;
    let registry: WatcherRegistry;
    let heard: Invalidation[];
    const hear = (i: Invalidation) => void heard.push(i);
    // One sweep of polled names (the darwin fake's, whose directory watch
    // reaches the tree), then one debounce window, closed.
    const settle = () => {
      clock.advance(0);
      clock.advance(NAMES_POLL_MS);
      clock.advance(DEBOUNCE_MS);
    };

    beforeEach(() => {
      clock = heldClock(new Date(1_000_000));
      disk = filesystemFake({ clock, platform });
      registry = new WatcherRegistry({ filesystem: disk, clock });
      heard = [];
    });
    afterEach(() => registry.closeAll());

    it("hears a named child written, by its path", () => {
      disk.mkdir("/cfg");
      registry.acquire(
        "k",
        { dirs: [{ path: "/cfg", filenames: ["a.json"] }] },
        hear,
      );
      disk.write("/cfg/a.json", "{}");
      disk.write("/cfg/other", "x");
      settle();
      expect(heard).toEqual([
        { kind: "changed", paths: new Set(["/cfg/a.json"]) },
      ]);
    });

    it("judges a folder made again at its path as moved, and listens to the new one", () => {
      disk.mkdir("/repo/git");
      registry.acquire(
        "k",
        { dirs: [{ path: "/repo/git", filenames: ["HEAD"] }] },
        hear,
      );
      disk.remove("/repo/git");
      disk.mkdir("/repo/git");
      settle();
      heard = [];
      registry.judge();
      settle();
      // The folder there now is heard, whichever platform's watch it is.
      disk.write("/repo/git/HEAD", "ref");
      settle();
      expect(heard.at(-1)).toEqual({
        kind: "changed",
        paths: new Set(["/repo/git/HEAD"]),
      });
      expect(registry.dirWatches() + registry.polledDirs()).toBe(1);
    });

    it("hears a re-pointed link in a config's chain", () => {
      disk.mkdir("/dots");
      disk.mkdir("/home");
      disk.write("/dots/a.json", "{}");
      disk.write("/dots/b.json", "{}");
      disk.symlink("/dots/a.json", "/home/c.json");
      const watch = watchTargetsOf(disk, {
        named: ["/home/c.json"],
        whole: [],
      });
      expect(watch.targets.dirs).toEqual([
        { path: "/dots", filenames: ["a.json"] },
        { path: "/home", filenames: ["c.json"] },
      ]);
      registry.acquire(watch.key, watch.targets, hear);
      disk.remove("/home/c.json");
      disk.symlink("/dots/b.json", "/home/c.json");
      settle();
      expect(heard).toEqual([
        { kind: "changed", paths: new Set(["/home/c.json"]) },
      ]);
      // The chain derived again names the new target: a new key to follow.
      const again = watchTargetsOf(disk, {
        named: ["/home/c.json"],
        whole: [],
      });
      expect(again.key).not.toBe(watch.key);
    });

    it("says a refused directory is deaf, and why", () => {
      disk.mkdir("/cfg");
      disk.refuseWatch("/cfg", "EMFILE");
      const handle = registry.acquire("k", { dirs: [{ path: "/cfg" }] }, hear);
      expect(handle.deaf).toEqual([
        {
          kind: "refused",
          path: "/cfg",
          reason: "EMFILE: too many open files, watch '/cfg'",
        },
      ]);
    });

    // What a stall of the OS's event stream deafens: every child and a tree
    // ride it on both platforms; a name rides it only where the directory
    // watch reaches one directory (Linux), since elsewhere it is polled.
    it("says which watches ride the OS's event stream", () => {
      disk.mkdir("/cfg/sub");
      const named = registry.acquire(
        "named",
        { dirs: [{ path: "/cfg", filenames: ["a.json"] }] },
        hear,
      );
      const everyChild = registry.acquire(
        "every",
        { dirs: [{ path: "/cfg/sub" }] },
        hear,
      );
      const tree = registry.acquire(
        "tree",
        { dirs: [{ path: "/cfg", recursive: true }] },
        hear,
      );
      const mixed = registry.acquire(
        "mixed",
        {
          dirs: [{ path: "/cfg", filenames: ["a.json"] }, { path: "/cfg/sub" }],
        },
        hear,
      );
      expect({
        named: named.ridesStream,
        everyChild: everyChild.ridesStream,
        tree: tree.ridesStream,
        mixed: mixed.ridesStream,
      }).toEqual({
        named: platform === "linux",
        everyChild: true,
        tree: true,
        mixed: true,
      });
    });
  });
}

// [LAW:behavior-not-structure] A registry over a disk whose directory watch
// reaches the tree (macOS's FSEvents) polls named entries: what a holder
// hears, and that a name costs no OS watch while every child still does.
describe("the watcher registry polling named entries", () => {
  let clock: HeldClock;
  let disk: FilesystemFake;
  let registry: WatcherRegistry;
  let heard: Invalidation[];
  const hear = (i: Invalidation) => void heard.push(i);
  // One sweep, then its debounce window, closed.
  const sweep = () => {
    clock.advance(NAMES_POLL_MS);
    clock.advance(DEBOUNCE_MS);
  };

  beforeEach(() => {
    clock = heldClock(new Date(1_000_000));
    disk = filesystemFake({ clock, platform: "darwin" });
    registry = new WatcherRegistry({ filesystem: disk, clock });
    heard = [];
  });
  afterEach(() => registry.closeAll());

  it("hears a named child made, written and removed, by its path, and no sibling", () => {
    disk.mkdir("/repo");
    registry.acquire(
      "k",
      { dirs: [{ path: "/repo", filenames: [".cc-candybar.json5"] }] },
      hear,
    );
    expect(disk.watching()).toEqual([]);
    expect(registry.polledDirs()).toBe(1);
    const changed = {
      kind: "changed",
      paths: new Set(["/repo/.cc-candybar.json5"]),
    };
    disk.write("/repo/.cc-candybar.json5", "{}");
    disk.write("/repo/node_modules", "x");
    sweep();
    expect(heard).toEqual([changed]);
    disk.write("/repo/.cc-candybar.json5", "{ a: 1 }");
    sweep();
    disk.remove("/repo/.cc-candybar.json5");
    sweep();
    expect(heard).toEqual([changed, changed, changed]);
    sweep();
    expect(heard).toHaveLength(3);
  });

  it("starts from what is there at the acquire, so an existing file is no event", () => {
    disk.mkdir("/cfg");
    disk.write("/cfg/config.json5", "{}");
    registry.acquire(
      "k",
      { dirs: [{ path: "/cfg", filenames: ["config.json5"] }] },
      hear,
    );
    sweep();
    expect(heard).toEqual([]);
  });

  it("tells an unknown window when another folder is at the path, and hears the new one", () => {
    disk.mkdir("/repo/git");
    registry.acquire(
      "k",
      { dirs: [{ path: "/repo/git", filenames: ["HEAD"] }] },
      hear,
    );
    disk.remove("/repo/git");
    disk.mkdir("/repo/git");
    sweep();
    expect(heard).toEqual([{ kind: "unknown" }]);
    disk.write("/repo/git/HEAD", "ref");
    sweep();
    expect(heard.at(-1)).toEqual({
      kind: "changed",
      paths: new Set(["/repo/git/HEAD"]),
    });
  });

  it("keeps an OS watch for a slot that hears every child, beside the polled names", () => {
    disk.mkdir("/plugins");
    registry.acquire(
      "names",
      { dirs: [{ path: "/plugins", filenames: ["a"] }] },
      hear,
    );
    registry.acquire("every", { dirs: [{ path: "/plugins" }] }, () => {});
    registry.acquire(
      "tree",
      { dirs: [{ path: "/plugins", recursive: true }] },
      () => {},
    );
    expect(registry.polledDirs()).toBe(1);
    expect(registry.dirWatches()).toBe(2);
  });

  it("refuses a directory it cannot list, as an OS watch would", () => {
    disk.mkdir("/locked");
    disk.fault("/locked", "EACCES");
    const handle = registry.acquire(
      "k",
      { dirs: [{ path: "/locked", filenames: ["a"] }] },
      hear,
    );
    expect(handle.deaf.map((d) => d.kind)).toEqual(["refused"]);
    disk.fault("/locked", null);
    registry.judge();
    expect(handle.deaf).toEqual([]);
    expect(registry.polledDirs()).toBe(1);
  });

  it("hears a named directory made again, not a child written inside it", () => {
    disk.mkdir("/repo/plugins");
    registry.acquire(
      "k",
      { dirs: [{ path: "/repo", filenames: ["plugins"] }] },
      hear,
    );
    disk.write("/repo/plugins/a.json", "{}");
    sweep();
    expect(heard).toEqual([]);
    disk.remove("/repo/plugins");
    disk.mkdir("/repo/plugins");
    sweep();
    expect(heard).toEqual([
      { kind: "changed", paths: new Set(["/repo/plugins"]) },
    ]);
  });

  it("hears a name's read start and stop failing, once each, and its neighbours go on", () => {
    disk.mkdir("/cfg");
    const handle = registry.acquire(
      "k",
      { dirs: [{ path: "/cfg", filenames: ["a", "b"] }] },
      hear,
    );
    const changed = (at: string) => ({ kind: "changed", paths: new Set([at]) });
    disk.fault("/cfg/a", "EIO");
    sweep();
    sweep();
    registry.judge();
    sweep();
    expect(heard).toEqual([changed("/cfg/a")]);
    expect(handle.deaf).toEqual([]);
    disk.write("/cfg/b", "{}");
    sweep();
    disk.fault("/cfg/a", null);
    sweep();
    expect(heard).toEqual([
      changed("/cfg/a"),
      changed("/cfg/b"),
      changed("/cfg/a"),
    ]);
  });

  it("starts a name asked for again after a release from what is there at the new acquire", () => {
    disk.mkdir("/cfg");
    registry.acquire("b", { dirs: [{ path: "/cfg", filenames: ["b"] }] }, hear);
    registry
      .acquire("a", { dirs: [{ path: "/cfg", filenames: ["a"] }] }, hear)
      .release();
    disk.write("/cfg/a", "{}");
    registry.acquire("a", { dirs: [{ path: "/cfg", filenames: ["a"] }] }, hear);
    sweep();
    expect(heard).toEqual([]);
  });

  it("stops polling a directory when its last holder releases it", () => {
    disk.mkdir("/cfg");
    const handle = registry.acquire(
      "k",
      { dirs: [{ path: "/cfg", filenames: ["a"] }] },
      hear,
    );
    handle.release();
    expect(registry.polledDirs()).toBe(0);
    disk.write("/cfg/a", "{}");
    sweep();
    expect(heard).toEqual([]);
  });
});
