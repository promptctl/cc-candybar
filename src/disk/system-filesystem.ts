import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// [LAW:effects-at-boundaries] exception: the birth-time probe below answers a
// fact of the process (libuv's), for an adapter its owners reach ambiently, so
// it is handed no world. The clock only bounds its wait and the scratch folder
// may be anywhere: neither changes the answer.
// eslint-disable-next-line no-restricted-imports -- see the exception above
import { systemTimekeeper } from "../time";
import {
  birthtimeOf,
  probeBirthtime,
  type BirthtimeVerdict,
} from "./birthtime-probe";
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

// [LAW:no-shared-mutable-globals] libuv's fallback is process-wide, so its
// answer is read once, on the first stat, and this module alone holds it.
let verdict: BirthtimeVerdict | undefined;
export const birthtimeVerdict = (): BirthtimeVerdict =>
  (verdict ??= probeBirthtime(
    {
      makeFolder: () =>
        // eslint-disable-next-line no-restricted-properties -- the exception at the clock's import
        fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-birthtime-")),
      stat: (at) => fs.statSync(at, { bigint: true }),
      // A chmod writes the folder's metadata, which moves its ctime and
      // nothing else.
      touch: (at) => fs.chmodSync(at, 0o700),
      remove: (at) => fs.rmdirSync(at),
    },
    systemTimekeeper,
  ));

const statOf = (st: fs.BigIntStats): Stat => ({
  kind: kindOf(st),
  size: Number(st.size),
  mtimeMs: Number(st.mtimeNs) / 1e6,
  mode: Number(st.mode),
  dev: st.dev,
  ino: st.ino,
  birthtimeNs: birthtimeOf(birthtimeVerdict(), st.birthtimeNs),
});

export const systemFilesystem: Filesystem = {
  statSync: (p) => statOf(fs.statSync(p, { bigint: true })),
  lstatSync: (p) => statOf(fs.lstatSync(p, { bigint: true })),
  readlinkSync: (p) => fs.readlinkSync(p),
  // The native realpath: the spelling the disk holds, letter case included.
  realpathSync: (p) => fs.realpathSync.native(p),
  mkdirSync: (p) => void fs.mkdirSync(p, { recursive: true }),
  opendirSync: (p) => fs.opendirSync(p).closeSync(),
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
