import { systemFilesystem } from "../src/disk/system-filesystem";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeAtomic } from "../src/utils/atomic-write.js";
import { linkChain, resolvedTarget } from "../src/utils/link-chain.js";
import { until } from "./helpers/until";

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
    expect(resolvedTarget(systemFilesystem, link)).toBe(
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
    expect(resolvedTarget(systemFilesystem, link)).toBe(fs.realpathSync(target));
    writeAtomic(link, "new");
    expect(fs.readFileSync(target, "utf8")).toBe("new");
  });

  test("a chain of links resolves to its last target; a loop throws", () => {
    const target = path.join(dir, "t.json");
    fs.symlinkSync(target, path.join(dir, "b.json"));
    fs.symlinkSync(path.join(dir, "b.json"), path.join(dir, "a.json"));
    expect(resolvedTarget(systemFilesystem, path.join(dir, "a.json"))).toBe(target);
    fs.symlinkSync(path.join(dir, "y"), path.join(dir, "x"));
    fs.symlinkSync(path.join(dir, "x"), path.join(dir, "y"));
    expect(() => resolvedTarget(systemFilesystem, path.join(dir, "x"))).toThrow(
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
    expect(linkChain(systemFilesystem, plain)).toEqual([plain]);
    const absent = path.join(dir, "absent.json5");
    expect(linkChain(systemFilesystem, absent)).toEqual([absent]);
    // An ancestor that is a regular file: the path does not exist either.
    const underFile = path.join(plain, "config.json5");
    expect(linkChain(systemFilesystem, underFile)).toEqual([underFile]);
  });

  test("a link lists itself and its target, a dangling target included", () => {
    fs.mkdirSync(path.join(dir, "dotfiles"));
    const target = path.join(fs.realpathSync(dir), "dotfiles", "config.json5");
    const link = path.join(dir, "config.json5");
    fs.symlinkSync(target, link);
    expect(linkChain(systemFilesystem, link)).toEqual([link, target]);
    fs.writeFileSync(target, "");
    expect(linkChain(systemFilesystem, link)).toEqual([link, target]);
  });

  test("a chain lists every hop in order, so a middle link re-pointed is heard", () => {
    const real = fs.realpathSync(dir);
    const profile = path.join(real, "profiles", "work.json5");
    const current = path.join(real, "current.json5");
    const link = path.join(dir, "config.json5");
    fs.symlinkSync(profile, current);
    fs.symlinkSync(current, link);
    expect(linkChain(systemFilesystem, link)).toEqual([link, current, profile]);
    expect(resolvedTarget(systemFilesystem, link)).toBe(profile);
  });

  test("a loop throws", () => {
    fs.symlinkSync(path.join(dir, "b"), path.join(dir, "a"));
    fs.symlinkSync(path.join(dir, "a"), path.join(dir, "b"));
    expect(() => linkChain(systemFilesystem, path.join(dir, "a"))).toThrow(
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

// Two processes write one file when they share a state directory (a daemon
// and a CLI, a test and the daemon it spawned). Each stages under its own
// name, so neither renames the other's bytes into place or away.
describe("writeAtomic across processes", () => {
  const TSX = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
  const CHILD = path.join(__dirname, "fixtures", "atomic-write-child.ts");
  const WRITES = 200;
  // Large enough that a write is still being staged when the other process
  // renames, so a shared staging name tears or loses it.
  const PAD_BYTES = 64 * 1024;

  test("every write stages at a name of its own, carrying the writer's pid", () => {
    const file = path.join(dir, "state.json");
    const rename = jest.spyOn(fs, "renameSync");
    try {
      writeAtomic(file, "{}");
      writeAtomic(file, "{}");
      const staged = rename.mock.calls.map(([from, to]) => {
        expect(to).toBe(file);
        return String(from).slice(file.length);
      });
      expect(staged).toEqual([
        expect.stringMatching(new RegExp(`^\\.${process.pid}\\.[0-9a-f-]{36}\\.tmp$`)),
        expect.stringMatching(new RegExp(`^\\.${process.pid}\\.[0-9a-f-]{36}\\.tmp$`)),
      ]);
      expect(staged[0]).not.toBe(staged[1]);
    } finally {
      rename.mockRestore();
    }
  });

  test("two writers of one file: neither fails, and every read is one complete write", async () => {
    const file = path.join(dir, "repo-configs.json");
    writeAtomic(file, JSON.stringify({ child: "seed", i: 0, pad: "" }));
    let ended = false;
    const children = ["a", "b"].map((name) => {
      // The sandbox env, as cli-plan's children get: the worker's own
      // NODE_OPTIONS is not the one test setup threads through.
      const child = spawn(TSX, [CHILD, file, name, String(WRITES), String(PAD_BYTES)], {
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (t: string) => (stdout += t));
      child.stderr.setEncoding("utf8").on("data", (t: string) => (stderr += t));
      let spawnError = "";
      const exited = new Promise<{ name: string; code: number | null; failure: string }>(
        (resolve) => {
          child.once("error", (e) => {
            spawnError = String(e);
            resolve({ name, code: null, failure: spawnError });
          });
          // The exit code says whether the child's writes all landed; its
          // stderr rides along to say why one did not.
          child.once("close", (code) =>
            resolve({ name, code, failure: code === 0 ? "" : stderr }),
          );
        },
      );
      return {
        child,
        ready: () => stdout.includes("ready"),
        state: () => `${name}: ${spawnError || stderr || (stdout ? "ready" : "silent")}`,
        exited,
      };
    });
    try {
      await until(
        () => children.every((c) => c.ready()),
        () => `both writers ready (${children.map((c) => c.state()).join("; ")})`,
        20_000,
      );
      for (const c of children) c.child.stdin.write("go");

      // Every read while both write, and the one after, parses as a whole
      // body one writer wrote.
      const torn: string[] = [];
      let exits: Awaited<(typeof children)[number]["exited"]>[] | null = null;
      void Promise.all(children.map((c) => c.exited)).then((all) => (exits = all));
      const readWhole = () => {
        const text = fs.readFileSync(file, "utf8");
        try {
          const body = JSON.parse(text) as { child: string; pad: string };
          if (!["seed", "a", "b"].includes(body.child)) torn.push(text.slice(0, 80));
        } catch {
          torn.push(`${text.length} bytes: ${text.slice(0, 40)}`);
        }
      };
      const sampling = (async () => {
        while (exits === null && !ended) {
          readWhole();
          // Paced to sample the file through the run without holding a core
          // the two writers and the suite's other workers need.
          await sleep(1);
        }
      })();
      await until(
        () => exits !== null,
        () => `both writers exited (${children.map((c) => c.state()).join("; ")})`,
        25_000,
      );
      await sampling;
      readWhole();

      expect(exits).toEqual([
        { name: "a", code: 0, failure: "" },
        { name: "b", code: 0, failure: "" },
      ]);
      expect(torn).toEqual([]);
      const last = JSON.parse(fs.readFileSync(file, "utf8")) as {
        child: string;
        i: number;
        pad: string;
      };
      expect({ i: last.i, pad: last.pad.length }).toEqual({
        i: WRITES - 1,
        pad: PAD_BYTES,
      });
      // Nothing staged is left beside the file.
      expect(fs.readdirSync(dir)).toEqual(["repo-configs.json"]);
    } finally {
      ended = true;
      // Neither child outlives the case, waiting or writing. A worker that
      // dies first closes their stdin, which ends one still waiting.
      for (const c of children) c.child.kill();
    }
  });
});
