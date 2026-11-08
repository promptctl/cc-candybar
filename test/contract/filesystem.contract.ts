import path from "node:path";
import type { Filesystem, FilesystemError } from "../../src/disk/filesystem";

// The setup a test does on the disk itself, beside the port: the fake does it
// in its tree, the real subject through `fs`.
export interface World {
  write(at: string, text: string): void;
  mkdir(at: string): void;
  symlink(target: string, at: string): void;
  remove(at: string): void;
}

// What a test of a Filesystem needs from its subject: the port, the world it
// reads, a fresh directory of its own, and `hear`, which applies `nudge` and
// waits until `heard()` holds. The fake applies it once and settles its clock,
// so a fake that needed a second write fails. The disk re-applies it each
// turn until heard, bounded by the test's timeout: a new watch can miss what
// lands before the OS is feeding it, and Linux's recursive watch is Node's own
// asynchronous walk, so the write goes in the subtree under test.
export interface Subject {
  readonly filesystem: Filesystem;
  readonly world: World;
  readonly root: string;
  hear(nudge: () => void, heard: () => boolean): Promise<void>;
}

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (e) {
    return (e as FilesystemError).code;
  }
  return undefined;
};

// [LAW:one-source-of-truth] What a Filesystem promises, stated once. The fake
// (test/unit/filesystem-fake.test.ts) and the disk
// (test/integration/system-filesystem.test.ts) both run it, so logic a unit
// test proves over the fake holds over the disk. Real time forbids exact
// figures, and the OS coalesces and reorders events: a watch case asserts an
// event naming the child arrived, never how many or of which type.
export function filesystemContract(name: string, make: () => Subject): void {
  describe(`${name} is a Filesystem`, () => {
    let s: Subject;
    let at: (...names: string[]) => string;
    beforeEach(() => {
      s = make();
      at = (...names) => path.join(s.root, ...names);
    });

    it("stats a file, a directory and a missing path", () => {
      s.world.write(at("f"), "hello");
      expect(s.filesystem.statSync(at("f"))).toMatchObject({
        kind: "file",
        size: 5,
      });
      expect(s.filesystem.statSync(s.root).kind).toBe("directory");
      let missing: FilesystemError | undefined;
      try {
        s.filesystem.statSync(at("nope"));
      } catch (e) {
        missing = e as FilesystemError;
      }
      expect(missing).toMatchObject({ code: "ENOENT", path: at("nope") });
      expect(missing?.message).toMatch(/^ENOENT: no such file or directory/);
      expect(codeOf(() => s.filesystem.statSync(at("f", "below")))).toBe(
        "ENOTDIR",
      );
    });

    it("follows a link for stat and realpath, and not for lstat", () => {
      s.world.mkdir(at("real"));
      s.world.write(at("real", "f"), "x");
      s.world.symlink(at("real"), at("link"));
      expect(s.filesystem.lstatSync(at("link")).kind).toBe("symlink");
      expect(s.filesystem.statSync(at("link")).kind).toBe("directory");
      expect(s.filesystem.readlinkSync(at("link"))).toBe(at("real"));
      expect(s.filesystem.realpathSync(at("link", "f"))).toBe(at("real", "f"));
      expect(codeOf(() => s.filesystem.readlinkSync(at("real")))).toBe(
        "EINVAL",
      );
    });

    it("reads a relative link against the directory it sits in", () => {
      s.world.mkdir(at("d"));
      s.world.write(at("d", "target"), "x");
      s.world.symlink("target", at("d", "rel"));
      expect(s.filesystem.realpathSync(at("d", "rel"))).toBe(at("d", "target"));
    });

    it("names a folder made again at its path as another folder", () => {
      s.world.mkdir(at("d"));
      const before = s.filesystem.statSync(at("d"));
      s.world.remove(at("d"));
      s.world.mkdir(at("d"));
      const after = s.filesystem.statSync(at("d"));
      expect([after.dev, after.ino, after.birthtimeNs]).not.toEqual([
        before.dev,
        before.ino,
        before.birthtimeNs,
      ]);
    });

    it("makes every missing ancestor, and an existing one is no error", () => {
      s.filesystem.mkdirSync(at("a", "b", "c"));
      s.filesystem.mkdirSync(at("a", "b", "c"));
      expect(s.filesystem.statSync(at("a", "b", "c")).kind).toBe("directory");
    });

    it("opens a directory, and refuses a file or a missing path", () => {
      s.world.write(at("f"), "x");
      expect(codeOf(() => s.filesystem.opendirSync(s.root))).toBeUndefined();
      expect(codeOf(() => s.filesystem.opendirSync(at("f")))).toBe("ENOTDIR");
      expect(codeOf(() => s.filesystem.opendirSync(at("nope")))).toBe("ENOENT");
    });

    it("writes, reads, lists and unlinks", async () => {
      s.world.mkdir(at("sub"));
      await s.filesystem.writeFile(at("f.json"), "{}");
      expect(await s.filesystem.readFile(at("f.json"))).toBe("{}");
      expect((await s.filesystem.stat(at("f.json"))).kind).toBe("file");
      const listed = await s.filesystem.readdir(s.root);
      expect([...listed].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: "f.json", kind: "file" },
        { name: "sub", kind: "directory" },
      ]);
      await s.filesystem.unlink(at("f.json"));
      await expect(s.filesystem.readFile(at("f.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("reads, lists, writes, renames and removes synchronously", () => {
      s.world.mkdir(at("sub"));
      s.filesystem.writeFileSync(at("f"), "one", { flush: true });
      expect(s.filesystem.readFileSync(at("f"))).toBe("one");
      expect(
        [...s.filesystem.readdirSync(s.root)].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      ).toEqual([
        { name: "f", kind: "file" },
        { name: "sub", kind: "directory" },
      ]);
      s.filesystem.writeFileSync(at("g"), "two", { flush: false });
      s.filesystem.renameSync(at("g"), at("f"));
      expect(s.filesystem.readFileSync(at("f"))).toBe("two");
      expect(codeOf(() => s.filesystem.readFileSync(at("g")))).toBe("ENOENT");
      s.filesystem.rmSync(at("f"));
      s.filesystem.rmSync(at("f"));
      expect(codeOf(() => s.filesystem.statSync(at("f")))).toBe("ENOENT");
      expect(codeOf(() => s.filesystem.rmSync(at("sub")))).toBe("EISDIR");
      expect(codeOf(() => s.filesystem.readdirSync(at("nope")))).toBe("ENOENT");
    });

    it("gives a new file the mode it was written with", () => {
      s.filesystem.writeFileSync(at("secret"), "x", {
        mode: 0o600,
        flush: true,
      });
      expect(s.filesystem.statSync(at("secret")).mode & 0o777).toBe(0o600);
    });

    it("writes through a dangling link to create its target", async () => {
      s.world.mkdir(at("d"));
      s.world.symlink("target", at("d", "link"));
      await s.filesystem.writeFile(at("d", "link"), "hi");
      expect(s.filesystem.lstatSync(at("d", "link")).kind).toBe("symlink");
      expect(await s.filesystem.readFile(at("d", "target"))).toBe("hi");
    });

    it("applies a `..` after the link before it", () => {
      s.world.mkdir(at("p", "q", "r"));
      s.world.symlink(at("p", "q", "r"), at("s"));
      // Spelled by hand: a join would fold the `..` away before the walk.
      expect(s.filesystem.realpathSync(`${at("s")}/..`)).toBe(
        s.filesystem.realpathSync(at("p", "q")),
      );
    });

    it("makes a folder named with a `..`, and writes after a link's `..`", async () => {
      s.filesystem.mkdirSync(`${at("a", "b")}/../c`);
      expect(s.filesystem.statSync(at("a", "c")).kind).toBe("directory");
      s.world.mkdir(at("real", "sub"));
      s.world.symlink(at("real", "sub"), at("L"));
      await s.filesystem.writeFile(`${at("L")}/../x`, "hi");
      expect(await s.filesystem.readFile(at("real", "x"))).toBe("hi");
    });

    describe("watch", () => {
      const opened: Array<{ close(): void }> = [];
      afterEach(() => {
        for (const w of opened.splice(0)) w.close();
      });

      const watch = (dir: string, recursive: boolean, names: string[]) => {
        const w = s.filesystem.watch(dir, { recursive }, (_event, name) => {
          if (name !== null) names.push(name);
        });
        opened.push(w);
        return w;
      };

      it("hears a child written in the directory, by name", async () => {
        const names: string[] = [];
        watch(s.root, false, names);
        let n = 0;
        await s.hear(
          () => s.world.write(at("child"), String(n++)),
          () => names.includes("child"),
        );
      });

      it("hears a write deep in a tree, by its path from the root", async () => {
        s.world.mkdir(at("a", "b"));
        const names: string[] = [];
        watch(s.root, true, names);
        let n = 0;
        await s.hear(
          () => s.world.write(at("a", "b", "f"), String(n++)),
          () => names.includes(path.join("a", "b", "f")),
        );
      });

      it("hears the watched folder's own removal, by its name", async () => {
        s.world.mkdir(at("w"));
        const names: string[] = [];
        watch(at("w"), false, names);
        let n = 0;
        await s.hear(
          () => s.world.write(at("w", "probe"), String(n++)),
          () => names.includes("probe"),
        );
        s.world.remove(at("w", "probe"));
        s.world.remove(at("w"));
        await s.hear(
          () => {},
          () => names.includes("w"),
        );
      });

      it("closes a watch twice without touching another", async () => {
        s.world.mkdir(at("b"));
        s.world.mkdir(at("c"));
        const names: string[] = [];
        const w = watch(at("b"), false, []);
        watch(at("c"), false, names);
        w.close();
        w.close();
        let n = 0;
        await s.hear(
          () => s.world.write(at("c", "f"), String(n++)),
          () => names.includes("f"),
        );
      });

      it("refuses a directory that is not there", () => {
        expect(
          codeOf(() =>
            s.filesystem.watch(at("nope"), { recursive: false }, () => {}),
          ),
        ).toBe("ENOENT");
      });
    });
  });
}
