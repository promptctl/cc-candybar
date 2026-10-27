import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  linkChain,
  resolvedTarget,
  writeAtomic,
} from "../src/utils/atomic-write.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-atomic-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("writeAtomic through symbolic links", () => {
  // A dotfiles-managed file is a link: the write lands where it points, and
  // the link stays a link.
  test("a link to a file: the target is rewritten, the link kept", () => {
    const target = path.join(dir, "target.json");
    const link = path.join(dir, "link.json");
    fs.writeFileSync(target, "old");
    fs.symlinkSync(target, link);
    writeAtomic(link, "new");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("new");
  });

  // A link whose target does not exist yet: the first write creates the
  // target rather than replacing the link with a file of its own.
  test("a dangling link: the write creates its target", () => {
    const target = path.join(dir, "later.json");
    const link = path.join(dir, "link.json");
    fs.symlinkSync("later.json", link);
    writeAtomic(link, "first");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("first");
    expect(resolvedTarget(link)).toBe(
      path.join(fs.realpathSync(dir), "later.json"),
    );
  });

  // A dangling link into a directory not created yet (a dotfiles tree not
  // yet populated): the write creates the directory and the file.
  test("a dangling link into a missing directory: both are created", () => {
    const link = path.join(dir, "link.json");
    const target = path.join(dir, "dotfiles", "nested", "settings.json");
    fs.symlinkSync(target, link);
    writeAtomic(link, "first");
    expect(fs.readFileSync(target, "utf8")).toBe("first");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  // The kernel reads a relative link against the directory it really sits
  // in: under a linked parent, `..` climbs from the parent's target.
  test("a relative link under a linked directory resolves as the kernel does", () => {
    const real = path.join(dir, "dotfiles", "claude");
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(path.join(dir, "dotfiles", "shared"));
    const target = path.join(dir, "dotfiles", "shared", "settings.json");
    fs.writeFileSync(target, "old");
    fs.symlinkSync("../shared/settings.json", path.join(real, "settings.json"));
    fs.symlinkSync(real, path.join(dir, "home-claude"));
    const link = path.join(dir, "home-claude", "settings.json");
    expect(resolvedTarget(link)).toBe(fs.realpathSync(target));
    writeAtomic(link, "new");
    expect(fs.readFileSync(target, "utf8")).toBe("new");
  });

  test("a chain of links resolves to its last target; a loop throws", () => {
    const target = path.join(dir, "t.json");
    fs.symlinkSync(target, path.join(dir, "b.json"));
    fs.symlinkSync(path.join(dir, "b.json"), path.join(dir, "a.json"));
    expect(resolvedTarget(path.join(dir, "a.json"))).toBe(target);
    fs.symlinkSync(path.join(dir, "y"), path.join(dir, "x"));
    fs.symlinkSync(path.join(dir, "x"), path.join(dir, "y"));
    expect(() => resolvedTarget(path.join(dir, "x"))).toThrow(
      /more than 40 symbolic links/,
    );
  });
});

// The chain is every place a change to the path can appear: a watcher needs
// each hop, because re-pointing any one link changes what the path reads.
describe("linkChain", () => {
  test("a plain path, present or absent, is one place", () => {
    const plain = path.join(dir, "config.json5");
    fs.writeFileSync(plain, "");
    expect(linkChain(plain)).toEqual([plain]);
    const absent = path.join(dir, "absent.json5");
    expect(linkChain(absent)).toEqual([absent]);
  });

  test("a link lists itself and its target, a dangling target included", () => {
    fs.mkdirSync(path.join(dir, "dotfiles"));
    const target = path.join(fs.realpathSync(dir), "dotfiles", "config.json5");
    const link = path.join(dir, "config.json5");
    fs.symlinkSync(target, link);
    expect(linkChain(link)).toEqual([link, target]);
    fs.writeFileSync(target, "");
    expect(linkChain(link)).toEqual([link, target]);
  });

  test("a chain lists every hop in order, so a middle link re-pointed is heard", () => {
    const real = fs.realpathSync(dir);
    const profile = path.join(real, "profiles", "work.json5");
    const current = path.join(real, "current.json5");
    const link = path.join(dir, "config.json5");
    fs.symlinkSync(profile, current);
    fs.symlinkSync(current, link);
    expect(linkChain(link)).toEqual([link, current, profile]);
    expect(resolvedTarget(link)).toBe(profile);
  });

  test("a loop throws", () => {
    fs.symlinkSync(path.join(dir, "b"), path.join(dir, "a"));
    fs.symlinkSync(path.join(dir, "a"), path.join(dir, "b"));
    expect(() => linkChain(path.join(dir, "a"))).toThrow(
      /more than 40 symbolic links/,
    );
  });
});

// Undo of a first-ever config write removes what that write created — the
// target behind a dangling link, never the link.
test("writeConfigText(null) through a link removes the target, keeps the link", async () => {
  const { writeConfigText } =
    await import("../src/daemon/config-file-store.js");
  const link = path.join(dir, "config.json5");
  fs.symlinkSync("dotfiles-config.json5", link);
  writeConfigText(link, "{}", () => {});
  writeConfigText(link, null, () => {});
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(path.join(dir, "dotfiles-config.json5"))).toBe(false);
});
