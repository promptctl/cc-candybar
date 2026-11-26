import fs from "node:fs";
import path from "node:path";
import { writeConfigFile } from "../daemon/file-rewrites.js";
import {
  asError,
  publishByRename,
  resolvedTarget,
  stagedName,
} from "../utils/atomic-write.js";
import { readTextIfPresent } from "../utils/regular-text.js";
import { UndoLog, type UndoFailure } from "../utils/undo-log.js";

// [LAW:single-enforcer] Every change an install makes to the user's files,
// made so that a failed install puts it back. A replaced file or directory
// keeps its old self aside, under a name of its own beside it, until the
// install finishes; a text file is written only over the bytes the install
// planned from; a directory the install created is removed. Every name this
// makes is unique to the call, so nothing a failed run leaves can stand in
// the next run's way, and each one left is named.
export class InstallChanges {
  private readonly log = new UndoLog();
  // The old copies kept aside, removed once the install stands.
  private readonly kept: string[] = [];

  // Roll back only directories this call created. A file another application
  // put in one while installation ran survives a later failure.
  mkdir(dir: string, mode?: number): void {
    const made = fs.mkdirSync(dir, { recursive: true, mode });
    if (made === undefined) return;
    const created = [dir];
    while (created[0] !== made) created.unshift(path.dirname(created[0]!));
    for (const directory of created) {
      this.log.landed(directory, () => {
        if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
      });
    }
  }

  // `dest` replaced in one rename, so a reader finds the old file or the new
  // one, never neither. The old file stays linked aside until the install
  // stands.
  replaceFile(dest: string, bytes: string | Uint8Array, mode: number): void {
    const old = present(dest) ? stagedName(dest) : null;
    if (old !== null) fs.linkSync(dest, old);
    try {
      publishByRename(dest, bytes, mode);
    } catch (e) {
      throw old === null ? e : removing(old, e);
    }
    this.landed(dest, old);
  }

  // `dest` replaced whole: `build` fills a directory beside it, and the old
  // one moves aside as the new one moves in. A build that fails leaves `dest`
  // as it was.
  replaceDir(dest: string, build: (staging: string) => void): void {
    const staging = stagedName(dest);
    try {
      build(staging);
    } catch (e) {
      throw removing(staging, e);
    }
    try {
      this.moveAside(dest);
      fs.renameSync(staging, dest);
    } catch (e) {
      throw removing(staging, e);
    }
    this.landed(dest, null);
  }

  // `file` gone from its place, kept aside until the install stands.
  remove(file: string): void {
    this.moveAside(file);
  }

  // `file`'s text replaced by `will`, only while it still holds `was`, the
  // bytes the install planned from: a write that landed since is never
  // overwritten. The undo writes `was` back only over `will`, for the same
  // reason. A link is written where it points (writeConfigFile).
  expectText(file: string, was: string | null): void {
    if (readTextIfPresent(file) !== was)
      throw new Error(
        `${file} changed while the install ran, so the install did not write it`,
      );
  }

  writeText(file: string, was: string | null, will: string): void {
    this.expectText(file, was);
    if (was === will) return;
    this.mkdir(path.dirname(resolvedTarget(file)));
    writeConfigFile(file, will);
    this.log.landed(file, () => {
      if (readTextIfPresent(file) !== will)
        throw new Error(
          `it changed after the install wrote it, so it is left as it is`,
        );
      writeConfigFile(file, was);
    });
  }

  // Every change put back, newest first: the ones that could not be.
  undo(): UndoFailure[] {
    return this.log.undo();
  }

  // The install stands: the old copies go. Returns each that would not.
  finish(): string[] {
    return this.kept.flatMap((old) => {
      try {
        fs.rmSync(old, { recursive: true, force: true });
        return [];
      } catch (e) {
        return [`${old} was left behind: ${asError(e).message}`];
      }
    });
  }

  private moveAside(file: string): void {
    if (!present(file)) return;
    const old = stagedName(file);
    fs.renameSync(file, old);
    this.landed(file, old);
  }

  // A change to `file` landed, its old self at `old`, or none there before.
  private landed(file: string, old: string | null): void {
    if (old === null) {
      this.log.landed(file, () =>
        fs.rmSync(file, { recursive: true, force: true }),
      );
      return;
    }
    this.kept.push(old);
    this.log.landed(file, () => {
      try {
        fs.renameSync(old, file);
      } catch (e) {
        // [LAW:no-silent-failure] The old bytes stay aside: say where.
        throw new Error(
          `${asError(e).message} — what it held is kept at ${old}`,
        );
      }
    });
  }
}

// A directory entry at `file`, a dangling link included.
function present(file: string): boolean {
  return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
}

// [LAW:no-silent-failure] A step's own error, after what it staged is
// removed; a staged name that would not go is added to the error.
function removing(staged: string, e: unknown): Error {
  const error = asError(e);
  try {
    fs.rmSync(staged, { recursive: true, force: true });
  } catch (removal) {
    error.message += `; ${staged} was left behind: ${asError(removal).message}`;
  }
  return error;
}

// [LAW:no-silent-failure] An install whose step throws puts back every
// change it made, and its error says so, naming each it could not put back.
// One that stands removes the old copies, and names each that would not go.
export function transacted<T>(install: (changes: InstallChanges) => T): T {
  const changes = new InstallChanges();
  let done: T;
  try {
    done = install(changes);
  } catch (e) {
    const error = asError(e);
    const unrestored = changes.undo();
    throw new Error(
      unrestored.length === 0
        ? `${error.message}\nThe install put back every change it made.`
        : `${error.message}\nThe install could not put back:\n${unrestored
            .map(({ file, error }) => `  ${file}: ${error.message}`)
            .join("\n")}`,
      { cause: error },
    );
  }
  for (const leftover of changes.finish())
    process.stderr.write(`install: ${leftover}\n`);
  return done;
}
