import fs from "fs";
import os from "os";
import path from "path";
import { nearestWatchTarget } from "../src/utils/watch-target";

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
    expect(nearestWatchTarget(path.join(root, "conf", "sub", "data"))).toEqual(
      { dir: root, name: "conf", leaf: false },
    );
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
