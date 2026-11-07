import fs from "node:fs";
import path from "node:path";
import type { Timekeeper } from "../time.js";
import {
  birthtimeOf,
  probeBirthtime,
  type BirthtimeVerdict,
} from "./birthtime-probe.js";
import type { DirectoryEntry, Filesystem, Stat } from "./filesystem.js";

// [LAW:effects-at-boundaries] The disk, through Node's `fs`. Errors pass
// through as Node raises them: they already carry the code, path and message
// the port promises. `fs.watch` is reached through the module object, so a
// test that still replaces it there (test/helpers/fake-watches.ts) reaches
// this adapter's watches too.

type Kinded = Pick<fs.BigIntStats, "isFile" | "isDirectory" | "isSymbolicLink">;

const kindOf = (st: Kinded): Stat["kind"] =>
  st.isSymbolicLink()
    ? "symlink"
    : st.isDirectory()
      ? "directory"
      : st.isFile()
        ? "file"
        : "other";

// [LAW:effects-at-boundaries] The birth-time probe's steps bound to `fs`, in
// a scratch folder under `parent`. libuv's fallback is process-wide, so a
// process main probes once, in a folder it owns and on its own clock, and
// builds its disk over the verdict (src/daemon/server.ts).
export const probeBirthtimeIn = (
  parent: string,
  clock: Pick<Timekeeper, "monotonic">,
): BirthtimeVerdict =>
  probeBirthtime(
    {
      makeFolder: () => fs.mkdtempSync(path.join(parent, "birthtime-")),
      stat: (at) => fs.statSync(at, { bigint: true }),
      // A chmod writes the folder's metadata, which moves its ctime and
      // nothing else.
      touch: (at) => fs.chmodSync(at, 0o700),
      remove: (at) => fs.rmdirSync(at),
    },
    clock,
  );

const statOf = (birthtime: BirthtimeVerdict, st: fs.BigIntStats): Stat => ({
  kind: kindOf(st),
  size: Number(st.size),
  mtimeMs: Number(st.mtimeNs) / 1e6,
  mode: Number(st.mode),
  dev: st.dev,
  ino: st.ino,
  birthtimeNs: birthtimeOf(birthtime, st.birthtimeNs),
});

// The disk with birth time as `birthtime` judges it.
export const systemFilesystemFor = (
  birthtime: BirthtimeVerdict,
): Filesystem => ({
  statSync: (p) => statOf(birthtime, fs.statSync(p, { bigint: true })),
  lstatSync: (p) => statOf(birthtime, fs.lstatSync(p, { bigint: true })),
  readlinkSync: (p) => fs.readlinkSync(p),
  // The native realpath: the spelling the disk holds, letter case included.
  realpathSync: (p) => fs.realpathSync.native(p),
  mkdirSync: (p) => void fs.mkdirSync(p, { recursive: true }),
  opendirSync: (p) => fs.opendirSync(p).closeSync(),
  stat: async (p) =>
    statOf(birthtime, await fs.promises.stat(p, { bigint: true })),
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
});

// The disk with birth time as libuv reports it. The paths, the atomic write
// and the installer read no birth time; a watch owner built over it (a
// test's) judges a folder by birth time as it stands.
export const systemFilesystem: Filesystem = systemFilesystemFor({
  kind: "unprobed",
  reason: "no probe outside a daemon",
});
