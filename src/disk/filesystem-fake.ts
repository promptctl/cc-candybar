import path from "node:path";
import type { Timekeeper } from "../time.js";
import type {
  DirectoryEntry,
  Filesystem,
  FilesystemError,
  Stat,
  Watch,
  WatchListener,
} from "./filesystem.js";

// [LAW:one-source-of-truth] A directory tree held in memory, whose every
// change is also what a watch on it hears: one tree answers the reads and
// raises the events, so the two cannot disagree. Imported only by tests and
// the fake assembly; it passes the same contract as the disk
// (test/contract/filesystem.contract.ts).
//
// [LAW:effects-at-boundaries] Events arrive through the injected clock's
// `defer`, never on the turn of the write, so a held clock decides when a
// watch hears; mtimes and birth times read the same clock.
//
// [LAW:dataflow-not-control-flow] The platform is a value, because the two
// differ in exactly what the watcher registry judges: Linux's inotify binds
// the directory's inode and follows it wherever it moves, while macOS's
// FSEvents follows the path, and a watched folder's own removal reaches its
// watch as a `rename` on Linux and a `change` on macOS, naming the folder.

type Platform = "darwin" | "linux";

interface Meta {
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
  mtimeMs: number;
  mode: number;
  parent: Directory | null;
  name: string;
}
interface Directory extends Meta {
  readonly kind: "directory";
  readonly children: Map<string, Entry>;
}
interface File extends Meta {
  readonly kind: "file";
  text: string;
}
interface Symlink extends Meta {
  readonly kind: "symlink";
  readonly target: string;
}
type Entry = Directory | File | Symlink;

interface OpenWatch {
  // What the watch is on: the inode it bound (Linux) or the path (macOS).
  readonly bound: Directory;
  readonly at: string;
  readonly recursive: boolean;
  readonly listener: WatchListener;
  readonly errors: Array<(error: Error) => void>;
  closed: boolean;
}

// Inspection and fault hooks, beside the port's operations: the setup a test
// does on the disk itself, and the faults the OS can raise.
export interface FilesystemFake extends Filesystem {
  write(at: string, text: string): void;
  mkdir(at: string): void;
  symlink(target: string, at: string): void;
  rename(from: string, to: string): void;
  remove(at: string): void;
  // Every later operation naming `at` fails with `code`, until it is
  // cleared with `null`.
  fault(at: string, code: string | null): void;
  // The next watch opened on `at` is refused with `code`.
  refuseWatch(at: string, code: string): void;
  // Every watch open on `at` reports an error and delivers nothing more.
  failWatch(at: string, message: string): void;
  // Every watch open on `at` hears an event naming no child.
  unnamedEvent(at: string): void;
  // The watches open now, by the path each was opened on.
  watching(): readonly string[];
}

const MAX_LINK_HOPS = 40;

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  ENOENT: "no such file or directory",
  ENOTDIR: "not a directory",
  EISDIR: "illegal operation on a directory",
  EACCES: "permission denied",
  ELOOP: "too many symbolic links encountered",
  EINVAL: "invalid argument",
  EEXIST: "file already exists",
  EMFILE: "too many open files",
  ENOSPC: "no space left on device",
  ENOTEMPTY: "directory not empty",
};

// Node's spelling of a failed call, so a fake's message reads as the disk's.
function failure(code: string, syscall: string, at: string): FilesystemError {
  const description = DESCRIPTIONS[code] ?? "operation failed";
  return Object.assign(
    new Error(`${code}: ${description}, ${syscall} '${at}'`),
    {
      code,
      syscall,
      path: at,
    },
  );
}

export function filesystemFake(opts: {
  readonly clock: Pick<Timekeeper, "now" | "defer">;
  readonly platform: Platform;
}): FilesystemFake {
  const { clock, platform } = opts;
  let inodes = 1n;
  const meta = (
    mode: number,
  ): Omit<Meta, "parent" | "name"> & {
    parent: null;
    name: string;
  } => {
    const ino = ++inodes;
    return {
      ino,
      birthtimeNs: BigInt(Math.round(clock.now())) * 1_000_000n + ino,
      mtimeMs: clock.now(),
      mode,
      parent: null,
      name: "",
    };
  };
  const root: Directory = {
    kind: "directory",
    children: new Map(),
    ...meta(0o40755),
  };
  const faults = new Map<string, string>();
  const refusals = new Map<string, string>();
  const watches: OpenWatch[] = [];

  const pathOf = (entry: Entry): string | null => {
    const names: string[] = [];
    let at: Entry = entry;
    while (at !== root) {
      if (at.parent === null) return null;
      names.unshift(at.name);
      at = at.parent;
    }
    return "/" + names.join("/");
  };

  const checkFault = (at: string, syscall: string): void => {
    const code = faults.get(at);
    if (code !== undefined) throw failure(code, syscall, at);
  };

  // The entry at `at`, following every link on the way and, when `follow`,
  // the last one too: the kernel's path walk.
  function walk(at: string, follow: boolean, syscall: string): Entry {
    checkFault(at, syscall);
    let hops = 0;
    const descend = (from: Directory, rest: string[], last: boolean): Entry => {
      let dir: Entry = from;
      for (let i = 0; i < rest.length; i++) {
        const name = rest[i]!;
        if (dir.kind !== "directory") throw failure("ENOTDIR", syscall, at);
        const next: Entry | undefined =
          name === ".." ? (dir.parent ?? root) : dir.children.get(name);
        if (next === undefined) throw failure("ENOENT", syscall, at);
        const isLast = i === rest.length - 1;
        if (next.kind === "symlink" && (!isLast || last)) {
          if (++hops > MAX_LINK_HOPS) throw failure("ELOOP", syscall, at);
          // A relative target walks from the link's directory, and a `..`
          // in it climbs from wherever the walk has got to, as the kernel's.
          dir = descend(
            next.target.startsWith("/") ? root : dir,
            names(next.target),
            true,
          );
        } else dir = next;
      }
      return dir;
    };
    return descend(root, parts(at), follow);
  }

  const names = (at: string): string[] =>
    at.split("/").filter((p) => p !== "" && p !== ".");
  // The path's names from the root, with `..` kept for the walk to apply
  // after following the link before it.
  const parts = (at: string): string[] =>
    names(path.isAbsolute(at) ? at : `${process.cwd()}/${at}`);

  const directoryAt = (at: string, syscall: string): Directory => {
    const entry = walk(at, true, syscall);
    if (entry.kind !== "directory") throw failure("ENOTDIR", syscall, at);
    return entry;
  };

  const statOf = (entry: Entry): Stat => ({
    kind: entry.kind,
    size:
      entry.kind === "file"
        ? Buffer.byteLength(entry.text)
        : entry.kind === "symlink"
          ? entry.target.length
          : 64,
    mtimeMs: entry.mtimeMs,
    mode: entry.mode,
    dev: 1n,
    ino: entry.ino,
    birthtimeNs: entry.birthtimeNs,
  });

  // The directory `inner` sits in, as a path relative to `outer`, or null
  // when it is not inside it.
  const relative = (outer: Directory, inner: Directory): string | null => {
    const names: string[] = [];
    for (let at: Directory | null = inner; at !== null; at = at.parent) {
      if (at === outer) return names.join("/");
      names.unshift(at.name);
    }
    return null;
  };

  // Where a watch reaches `dir` from: through the inode it bound (Linux), or
  // through the folder at its path now (macOS).
  const reach = (w: OpenWatch, dir: Directory): string | null => {
    if (platform === "linux") return relative(w.bound, dir);
    let now: Entry;
    try {
      now = walk(w.at, true, "watch");
    } catch {
      return null;
    }
    return now.kind === "directory" ? relative(now, dir) : null;
  };

  const deliver = (w: OpenWatch, run: () => void): void =>
    void clock.defer(() => {
      if (!w.closed) run();
    });

  // A child of `dir` came, went or changed: every watch that reaches it
  // hears the child by name, relative to the watch's root.
  function changed(
    dir: Directory,
    name: string,
    event: "rename" | "change",
  ): void {
    for (const w of watches) {
      if (w.closed) continue;
      const rel = reach(w, dir);
      if (rel === null || (rel !== "" && !w.recursive)) continue;
      const named = rel === "" ? name : `${rel}/${name}`;
      deliver(w, () => w.listener(event, named));
    }
  }

  // `entry` left its path: a watch bound to it, or on its path, hears its own
  // name, as each platform reports it.
  function left(entry: Entry, at: string): void {
    if (entry.kind !== "directory") return;
    for (const w of watches) {
      if (w.closed) continue;
      const own =
        platform === "linux" ? w.bound === entry : path.resolve(w.at) === at;
      if (!own) continue;
      const event = platform === "linux" ? "rename" : "change";
      deliver(w, () => w.listener(event, path.basename(w.at)));
    }
  }

  const touch = (dir: Directory): void => {
    dir.mtimeMs = clock.now();
  };

  function attach(dir: Directory, name: string, entry: Entry): void {
    entry.parent = dir;
    entry.name = name;
    dir.children.set(name, entry);
    touch(dir);
    changed(dir, name, "rename");
  }

  // Every directory under `dir`, by its path under `at`.
  function* below(dir: Directory, at: string): Generator<[Directory, string]> {
    for (const child of dir.children.values())
      if (child.kind === "directory") {
        const childAt = path.join(at, child.name);
        yield [child, childAt];
        yield* below(child, childAt);
      }
  }

  // A removal leaves every folder under the entry gone, so each one's watch
  // hears it. A move leaves a path-bound watch (macOS) under it without its
  // folder, while an inode-bound one (Linux) moves with its folder and hears
  // nothing.
  function detach(entry: Entry, how: "remove" | "move"): void {
    const dir = entry.parent!;
    const at = pathOf(entry)!;
    dir.children.delete(entry.name);
    entry.parent = null;
    touch(dir);
    changed(dir, entry.name, "rename");
    left(entry, at);
    if (
      entry.kind === "directory" &&
      (how === "remove" || platform === "darwin")
    )
      for (const [child, childAt] of below(entry, at)) left(child, childAt);
  }

  const linkAt = (at: string, syscall: string): Symlink | null => {
    try {
      const entry = walk(at, false, syscall);
      return entry.kind === "symlink" ? entry : null;
    } catch (e) {
      if ((e as FilesystemError).code === "ENOENT") return null;
      throw e;
    }
  };
  const exists = (at: string): boolean => {
    try {
      walk(at, true, "stat");
      return true;
    } catch (e) {
      if ((e as FilesystemError).code === "ENOENT") return false;
      throw e;
    }
  };

  // The directory a new entry at `at` goes into, and its name there.
  const slot = (at: string, syscall: string) => {
    checkFault(at, syscall);
    const dir = directoryAt(path.dirname(path.resolve(at)), syscall);
    return { dir, name: path.basename(at) };
  };

  function writeText(at: string, text: string, syscall: string): void {
    checkFault(at, syscall);
    const link = linkAt(at, syscall);
    // A write through a link whose target is missing creates the target.
    if (link !== null && !exists(at))
      return writeText(
        link.target.startsWith("/")
          ? link.target
          : `${path.dirname(path.resolve(at))}/${link.target}`,
        text,
        syscall,
      );
    let existing: Entry | null = null;
    try {
      existing = walk(at, true, syscall);
    } catch (e) {
      if ((e as FilesystemError).code !== "ENOENT") throw e;
    }
    if (existing?.kind === "directory") throw failure("EISDIR", syscall, at);
    if (existing?.kind === "file") {
      existing.text = text;
      existing.mtimeMs = clock.now();
      changed(existing.parent!, existing.name, "change");
      return;
    }
    const { dir, name } = slot(at, syscall);
    attach(dir, name, { kind: "file", text, ...meta(0o100644) });
  }

  function mkdirp(at: string): void {
    checkFault(at, "mkdir");
    let dir = root;
    for (const name of parts(at)) {
      const next = dir.children.get(name);
      if (next === undefined) {
        const made: Directory = {
          kind: "directory",
          children: new Map(),
          ...meta(0o40755),
        };
        attach(dir, name, made);
        dir = made;
        continue;
      }
      const resolved =
        next.kind === "symlink" ? walk(pathOf(next)!, true, "mkdir") : next;
      if (resolved.kind !== "directory") throw failure("EEXIST", "mkdir", at);
      dir = resolved;
    }
  }

  return {
    statSync: (at) => statOf(walk(at, true, "stat")),
    lstatSync: (at) => statOf(walk(at, false, "lstat")),
    readlinkSync: (at) => {
      const entry = walk(at, false, "readlink");
      if (entry.kind !== "symlink") throw failure("EINVAL", "readlink", at);
      return entry.target;
    },
    realpathSync: (at) => pathOf(walk(at, true, "realpath")) ?? at,
    mkdirSync: mkdirp,
    opendirSync: (at) => void directoryAt(at, "opendir"),
    stat: async (at) => statOf(walk(at, true, "stat")),
    readFile: async (at) => {
      const entry = walk(at, true, "open");
      if (entry.kind !== "file") throw failure("EISDIR", "read", at);
      return entry.text;
    },
    writeFile: async (at, text) => writeText(at, text, "open"),
    readdir: async (at) =>
      [...directoryAt(at, "scandir").children.values()].map(
        (entry): DirectoryEntry => ({ name: entry.name, kind: entry.kind }),
      ),
    unlink: async (at) => {
      const entry = walk(at, false, "unlink");
      if (entry.kind === "directory") throw failure("EISDIR", "unlink", at);
      detach(entry, "remove");
    },
    watch: (at, { recursive }, listener): Watch => {
      const refused = refusals.get(at);
      if (refused !== undefined) {
        refusals.delete(at);
        throw failure(refused, "watch", at);
      }
      const bound = directoryAt(at, "watch");
      const w: OpenWatch = {
        bound,
        at,
        recursive,
        listener,
        errors: [],
        closed: false,
      };
      watches.push(w);
      return {
        close: () => {
          w.closed = true;
          const open = watches.indexOf(w);
          if (open !== -1) watches.splice(open, 1);
        },
        onError: (l) => void w.errors.push(l),
      };
    },

    write: (at, text) => writeText(at, text, "open"),
    mkdir: mkdirp,
    symlink: (target, at) => {
      const { dir, name } = slot(at, "symlink");
      if (dir.children.has(name)) throw failure("EEXIST", "symlink", at);
      attach(dir, name, { kind: "symlink", target, ...meta(0o120755) });
    },
    rename: (from, to) => {
      const entry = walk(from, false, "rename");
      const { dir, name } = slot(to, "rename");
      const replaced = dir.children.get(name);
      if (replaced !== undefined && replaced !== entry) {
        // The kernel's checks on the destination it replaces.
        if (entry.kind === "directory" && replaced.kind !== "directory")
          throw failure("ENOTDIR", "rename", to);
        if (entry.kind !== "directory" && replaced.kind === "directory")
          throw failure("EISDIR", "rename", to);
        if (replaced.kind === "directory" && replaced.children.size > 0)
          throw failure("ENOTEMPTY", "rename", to);
        detach(replaced, "remove");
      }
      detach(entry, "move");
      attach(dir, name, entry);
    },
    remove: (at) => detach(walk(at, false, "rm"), "remove"),
    fault: (at, code) =>
      void (code === null ? faults.delete(at) : faults.set(at, code)),
    refuseWatch: (at, code) => void refusals.set(at, code),
    failWatch: (at, message) => {
      for (const w of watches.filter((open) => open.at === at))
        deliver(w, () => {
          for (const l of w.errors) l(new Error(message));
          w.closed = true;
        });
    },
    unnamedEvent: (at) => {
      for (const w of watches.filter((open) => open.at === at))
        deliver(w, () => w.listener("rename", null));
    },
    watching: () => watches.map((w) => w.at),
  };
}
