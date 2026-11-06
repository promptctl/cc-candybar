// [LAW:behavior-not-structure] The watcher registry over the filesystem fake:
// what a holder hears when files, folders and links change, with no disk and
// no real time. The fake stands for both platforms the registry judges.

import {
  DEBOUNCE_MS,
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
    // One debounce window, closed.
    const settle = () => {
      clock.advance(0);
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
      expect(registry.dirWatches()).toBe(1);
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
  });
}
