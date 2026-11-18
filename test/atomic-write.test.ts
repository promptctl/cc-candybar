import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  linkChain,
  publish,
  publishAsync,
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
    // An ancestor that is a regular file: the path does not exist either.
    const underFile = path.join(plain, "config.json5");
    expect(linkChain(underFile)).toEqual([underFile]);
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

describe("publish", () => {
  const staging = (file: string): string[] =>
    fs.readdirSync(path.dirname(file)).filter((n) => n !== path.basename(file));

  test("each call stages under a name of its own, and leaves nothing behind", () => {
    const file = path.join(dir, "state.json");
    const seen = new Set<string>();
    const admit = (staged: string): boolean => {
      seen.add(staged);
      return true;
    };
    publish(file, "one", { by: "rename", admit });
    publish(file, "two", { by: "rename", admit });
    expect(seen.size).toBe(2);
    for (const staged of seen) {
      expect(path.dirname(staged)).toBe(dir);
      expect(path.basename(staged)).toContain(`.${process.pid}.`);
    }
    expect(fs.readFileSync(file, "utf8")).toBe("two");
    expect(staging(file)).toEqual([]);
  });

  test("a link lands only where nothing is: the first write wins", () => {
    const file = path.join(dir, "key");
    expect(publish(file, "first", { by: "link" })).toBe(true);
    expect(publish(file, "second", { by: "link" })).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("first");
    expect(staging(file)).toEqual([]);
  });

  test("a write admit declines publishes nothing and leaves nothing", () => {
    const file = path.join(dir, "state.json");
    expect(publish(file, "x", { by: "rename", admit: () => false })).toBe(
      false,
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("the mode applies to the published file", () => {
    const file = path.join(dir, "secret");
    publish(file, "k", { by: "rename", mode: 0o600 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  // A publish that fails reports its own error with its own code; a cleanup
  // that fails too is added to that error's message, never put in its place.
  test("a failed publish throws its own error, and a failed cleanup is attached", () => {
    // A non-empty directory under the file's name refuses the rename.
    const file = path.join(dir, "state.json");
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, "inside"), "");
    let failed: NodeJS.ErrnoException | undefined;
    try {
      publish(file, "x", {
        by: "rename",
        // The staged file becomes a directory, which the cleanup cannot
        // remove.
        admit: (staged) => {
          fs.rmSync(staged);
          fs.mkdirSync(staged);
          fs.writeFileSync(path.join(staged, "inside"), "");
          return true;
        },
      });
    } catch (e) {
      failed = e as NodeJS.ErrnoException;
    }
    expect(failed?.syscall).toBe("rename");
    expect(failed?.message).toMatch(/the staged file .* was left behind/);
  });

  test("an async publish stages, publishes and cleans up the same way", async () => {
    const file = path.join(dir, "state.json");
    expect(
      await publishAsync(file, "one", { by: "rename", mode: 0o600 }),
    ).toBe(true);
    expect(await publishAsync(file, "two", { by: "link" })).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("one");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(staging(file)).toEqual([]);
  });

  // Two processes writing one file never publish or remove each other's
  // staged bytes: every write completes, every read between them parses as
  // one whole write, and the last complete write is what stays.
  test("two processes writing one file race without a torn, lost or failed write", async () => {
    const file = path.join(dir, "repo-configs.json");
    const writes = 100;
    const child = (who: string): ChildProcess =>
      spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "-e",
          `import { writeAtomic } from ${JSON.stringify(path.resolve("src/utils/atomic-write.ts"))};` +
            `import fs from "node:fs";` +
            `const pad = "${who}".repeat(64 * 1024);` +
            `process.stdout.write("ready\\n");` +
            `process.stdin.once("data", () => {` +
            `  for (let i = 0; i < ${writes}; i++) {` +
            `    writeAtomic(${JSON.stringify(file)}, JSON.stringify({ who: "${who}", i, pad }));` +
            `    JSON.parse(fs.readFileSync(${JSON.stringify(file)}, "utf8"));` +
            `  }` +
            `  process.exit(0);` +
            `});`,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
    const ended = (
      c: ChildProcess,
    ): Promise<{ code: number | null; stderr: string }> =>
      new Promise((resolve) => {
        let stderr = "";
        c.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
        c.on("exit", (code) => resolve({ code, stderr }));
      });
    const ready = (c: ChildProcess): Promise<void> =>
      new Promise((resolve) => c.stdout!.once("data", () => resolve()));
    const children = [child("a"), child("b")];
    const ends = children.map(ended);
    await Promise.all(children.map(ready));
    for (const c of children) c.stdin!.write("go\n");
    // The stderr rides along so a failure shows the child's error.
    const clean = { code: 0, stderr: expect.not.stringContaining("Error:") };
    expect(await Promise.all(ends)).toEqual([clean, clean]);
    const last = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(last.i).toBe(writes - 1);
    expect(last.pad).toBe(last.who.repeat(64 * 1024));
    expect(fs.readdirSync(dir)).toEqual(["repo-configs.json"]);
  }, 60_000);
});
