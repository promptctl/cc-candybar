import fs from "node:fs";
import type { DirectoryEntry, Filesystem, Stat } from "./filesystem.js";

// [LAW:effects-at-boundaries] The disk, through Node's `fs`. Errors pass
// through as Node raises them: they already carry the code, path and message
// the port promises, save rm's, whose code is translated to the errno.
// `fs.watch` is reached through the module object, so a test that still
// replaces it there (test/helpers/fake-watches.ts) reaches this adapter's
// watches too.

type Kinded = Pick<fs.BigIntStats, "isFile" | "isDirectory" | "isSymbolicLink">;

const kindOf = (st: Kinded): Stat["kind"] =>
  st.isSymbolicLink()
    ? "symlink"
    : st.isDirectory()
      ? "directory"
      : st.isFile()
        ? "file"
        : "other";

const statOf = (st: fs.BigIntStats): Stat => ({
  kind: kindOf(st),
  size: Number(st.size),
  mtimeMs: Number(st.mtimeNs) / 1e6,
  mode: Number(st.mode),
  dev: st.dev,
  ino: st.ino,
  birthtimeNs: st.birthtimeNs,
});

export const systemFilesystem: Filesystem = {
  watchReach: process.platform === "darwin" ? "tree" : "directory",
  statSync: (p) => statOf(fs.statSync(p, { bigint: true })),
  lstatSync: (p) => statOf(fs.lstatSync(p, { bigint: true })),
  readlinkSync: (p) => fs.readlinkSync(p),
  // The native realpath: the spelling the disk holds, letter case included.
  realpathSync: (p) => fs.realpathSync.native(p),
  mkdirSync: (p) => void fs.mkdirSync(p, { recursive: true }),
  opendirSync: (p) => fs.opendirSync(p).closeSync(),
  readFileSync: (p) => fs.readFileSync(p, "utf8"),
  readdirSync: (p) =>
    fs
      .readdirSync(p, { withFileTypes: true })
      .map(
        (entry): DirectoryEntry => ({ name: entry.name, kind: kindOf(entry) }),
      ),
  writeFileSync: (p, text, { mode, flush }) =>
    fs.writeFileSync(p, text, { mode, flush }),
  renameSync: (from, to) => fs.renameSync(from, to),
  // [LAW:one-source-of-truth] The port speaks errno: Node's rm names a
  // directory with its own ERR_FS_EISDIR, which is the errno EISDIR that
  // unlink raises for the same refusal.
  rmSync: (p) => {
    try {
      fs.rmSync(p, { force: true });
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === "ERR_FS_EISDIR") err.code = "EISDIR";
      throw e;
    }
  },
  stat: async (p) => statOf(await fs.promises.stat(p, { bigint: true })),
  readFile: (p) => fs.promises.readFile(p, "utf8"),
  writeFile: (p, text) => fs.promises.writeFile(p, text),
  readdir: async (p) =>
    (await fs.promises.readdir(p, { withFileTypes: true })).map(
      (entry): DirectoryEntry => ({ name: entry.name, kind: kindOf(entry) }),
    ),
  unlink: (p) => fs.promises.unlink(p),
  watch: (dir, { recursive }, listener) => {
    // A daemon's watch never holds the process open.
    const handle = fs.watch(
      dir,
      { persistent: false, recursive },
      (event, name) => listener(event, name),
    );
    return {
      close: () => handle.close(),
      onError: (l) => void handle.on("error", l),
    };
  },
};
