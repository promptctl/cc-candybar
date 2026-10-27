import fs from "fs";
import os from "os";
import path from "path";
import { nearestWatchTarget, watchedPathsOf } from "../src/utils/watch-target";

describe("nearestWatchTarget", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-")));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("watches the parent for the file's name once the parent exists", () => {
    expect(nearestWatchTarget(path.join(root, "data"))).toEqual({
      dir: root,
      name: "data",
      leaf: true,
    });
  });

  it("watches the deepest existing directory for the missing one's name", () => {
    expect(nearestWatchTarget(path.join(root, "a", "b", "data"))).toEqual({
      dir: root,
      name: "a",
      leaf: false,
    });
  });

  it("walks past a regular file in an ancestor position", () => {
    fs.writeFileSync(path.join(root, "conf"), "");
    expect(nearestWatchTarget(path.join(root, "conf", "sub", "data"))).toEqual({
      dir: root,
      name: "conf",
      leaf: false,
    });
  });

  it("names one directory through a symlink whether or not the leaf exists", () => {
    fs.mkdirSync(path.join(root, "real"));
    fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
    const viaLink = path.join(root, "link", "data");
    const before = nearestWatchTarget(viaLink);
    fs.writeFileSync(path.join(root, "real", "data"), "");
    expect(before).toEqual(nearestWatchTarget(fs.realpathSync(viaLink)));
    expect(before.dir).toBe(path.join(root, "real"));
  });
});

describe("watchedPathsOf", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wp-")));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("a plain path is watched in one place", () => {
    const plain = path.join(root, "config.json5");
    fs.writeFileSync(plain, "");
    expect(watchedPathsOf(plain)).toEqual([plain]);
    expect(watchedPathsOf(path.join(root, "absent.json5"))).toEqual([
      path.join(root, "absent.json5"),
    ]);
  });

  it("a link is watched as spelled and where a write to it lands", () => {
    fs.mkdirSync(path.join(root, "dotfiles"));
    const target = path.join(root, "dotfiles", "config.json5");
    fs.writeFileSync(target, "");
    const link = path.join(root, "config.json5");
    fs.symlinkSync(target, link);
    expect(watchedPathsOf(link)).toEqual([link, target]);
  });

  it("a dangling link is watched where its target will appear", () => {
    const target = path.join(root, "dotfiles", "config.json5");
    const link = path.join(root, "config.json5");
    fs.symlinkSync(target, link);
    expect(watchedPathsOf(link)).toEqual([link, target]);
    expect(nearestWatchTarget(target)).toEqual({
      dir: root,
      name: "dotfiles",
      leaf: false,
    });
  });

  it("a link loop is watched as spelled", () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    expect(watchedPathsOf(a)).toEqual([a]);
  });
});
