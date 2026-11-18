import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  linkChain,
  publishByLink,
  publishByRename,
  publishByRenameAsync,
  resolvedTarget,
  writeAtomic,
} from "../src/utils/atomic-write.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-atomic-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const refused = (code: string) => () => {
  throw Object.assign(new Error(`${code}: refused`), { code });
};

// [LAW:one-source-of-truth] One contract for both rename forms: the async one
// is the sync one on the thread pool, and differs in nothing a caller sees.
describe.each([
  {
    form: "publishByRename",
    publish: async (file: string, bytes: string, mode?: number) =>
      publishByRename(file, bytes, mode),
    renameOf: (): jest.SpiedFunction<() => void> =>
      jest.spyOn(fs, "renameSync") as never,
  },
  {
    form: "publishByRenameAsync",
    publish: publishByRenameAsync,
    renameOf: (): jest.SpiedFunction<() => void> =>
      jest.spyOn(fs.promises, "rename") as never,
  },
])("$form", ({ publish, renameOf }) => {
  test("the last write is the file, and nothing staged is left beside it", async () => {
    const file = path.join(dir, "state.json");
    await publish(file, "first");
    await publish(file, "second", 0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("second");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
  });

  test("a refused publish throws its own error and removes what it staged", async () => {
    const file = path.join(dir, "state.json");
    const spy = renameOf().mockImplementationOnce(refused("EIO"));
    try {
      await expect(publish(file, "bytes")).rejects.toMatchObject({
        code: "EIO",
      });
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  // A cleanup that fails too is said in the write's own error, which keeps
  // its code for the caller to branch on.
  test("a staged file that will not go is added to the publish's error", async () => {
    const file = path.join(dir, "state.json");
    const rename = renameOf().mockImplementationOnce(refused("EIO"));
    const rm = jest.spyOn(fs, "rmSync").mockImplementationOnce(refused("EBUSY"));
    let thrown: unknown;
    try {
      await publish(file, "bytes").catch((e: unknown) => (thrown = e));
    } finally {
      rename.mockRestore();
      rm.mockRestore();
    }
    const staged = path.join(dir, ...fs.readdirSync(dir));
    expect(thrown).toMatchObject({ code: "EIO" });
    expect((thrown as Error).message).toBe(
      `EIO: refused; the staged file ${staged} was left behind: EBUSY: refused`,
    );
  });
});

describe("publishByLink", () => {
  test("the first write is published, a later one finds it taken", () => {
    const file = path.join(dir, "key");
    expect(publishByLink(file, "first", 0o600)).toBe("published");
    expect(publishByLink(file, "second", 0o600)).toBe("taken");
    expect(fs.readFileSync(file, "utf8")).toBe("first");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["key"]);
  });

  test("a link that fails other than taken throws, and removes what it staged", () => {
    const file = path.join(dir, "key");
    const spy = jest.spyOn(fs, "linkSync").mockImplementationOnce(refused("EIO"));
    try {
      expect(() => publishByLink(file, "bytes")).toThrow(
        expect.objectContaining({ code: "EIO" }),
      );
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  // The publish stands, so the error says it did, beside the staged path.
  test("a staged file that will not go after the link is said with the outcome", () => {
    const file = path.join(dir, "key");
    const spy = jest.spyOn(fs, "rmSync").mockImplementationOnce(refused("EBUSY"));
    try {
      expect(() => publishByLink(file, "bytes")).toThrow(
        new RegExp(`^${file}: published, but the staged file ${file}\\..+\\.tmp was left behind: EBUSY: refused$`),
      );
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(file, "utf8")).toBe("bytes");
  });
});

// [LAW:no-ambient-temporal-coupling] Two processes writing one file stage
// under names of their own: neither publishes nor removes the other's bytes,
// every read between writes is one whole write, and the last stands.
test("two processes writing one file never publish or remove each other's bytes", async () => {
  const file = path.join(dir, "shared.json");
  const writes = 100;
  const writer = (who: string) =>
    spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `import fs from "node:fs";` +
          `import { writeAtomic } from ${JSON.stringify(path.resolve("src/utils/atomic-write.ts"))};` +
          `process.stdout.write("ready\\n");` +
          `process.stdin.once("data", () => {` +
          `  for (let i = 0; i < ${writes}; i++) {` +
          `    writeAtomic(${JSON.stringify(file)}, JSON.stringify({ who: ${JSON.stringify(who)}, i, pad: ${JSON.stringify(who)}.repeat(64 * 1024) }));` +
          `    const read = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, "utf8"));` +
          `    if (read.pad.length !== 64 * 1024) throw new Error("torn read at " + i);` +
          `  }` +
          `  process.exit(0);` +
          `});`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  const children = [writer("a"), writer("b")];
  const stderr = children.map((child) => {
    let text = "";
    child.stderr!.on("data", (chunk) => (text += chunk));
    return () => text;
  });
  await Promise.all(children.map((child) => once(child.stdout!, "data")));
  const exits = children.map((child) => once(child, "exit"));
  for (const child of children) child.stdin!.write("go\n");
  const codes = (await Promise.all(exits)).map(([code]) => code);

  expect({ codes, stderr: stderr.map((text) => text()) }).toEqual({
    codes: [0, 0],
    stderr: [
      expect.not.stringContaining("Error"),
      expect.not.stringContaining("Error"),
    ],
  });
  const last = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(last.i).toBe(writes - 1);
  expect(last.pad).toBe(last.who.repeat(64 * 1024));
  expect(fs.readdirSync(dir)).toEqual(["shared.json"]);
});

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
