import fs from "node:fs";
import path from "node:path";
import {
  asError,
  filePermissions,
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
  private readonly publications: Array<() => void> = [];
  private readonly reports: Array<() => void> = [];

  publish(): void {
    for (const publish of this.publications) publish();
  }

  afterPublish(action: () => void): void {
    this.publications.push(action);
  }

  report(message: string, stream: "stdout" | "stderr" = "stdout"): void {
    this.reports.push(() => process[stream].write(message));
  }

  // The old copies kept aside, removed once the install stands.
  private readonly kept: string[] = [];

  // Roll back only directories this call created. A file another application
  // put in one while installation ran survives a later failure.
  mkdir(dir: string, mode?: number): void {
    const target = path.resolve(dir);
    const made = fs.mkdirSync(target, { recursive: true, mode });
    if (made === undefined) return;
    const created = [target];
    while (created[0] !== made) created.unshift(path.dirname(created[0]!));
    for (const directory of created) {
      this.log.landed(directory, () => {
        if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
      });
    }
  }

  // Prepare artifacts beside their targets. Signing and copying finish before
  // any existing runtime or app path changes. Only the final renames and
  // Launch Services registration can require restoring a published version.
  replaceFile(dest: string, bytes: string | Uint8Array, mode?: number): void {
    this.prepare(
      dest,
      (staging) => {
        fs.writeFileSync(staging, bytes, { flag: "wx", mode });
        if (mode !== undefined) fs.chmodSync(staging, mode);
      },
      false,
    );
  }

  replaceDir(dest: string, build: (staging: string) => void): void {
    this.prepare(dest, build, true);
  }

  private prepare(
    dest: string,
    build: (staging: string) => void,
    directory: boolean,
  ): void {
    const staging = stagedName(dest);
    this.log.landed(staging, () =>
      fs.rmSync(staging, { recursive: true, force: true }),
    );
    build(staging);
    this.afterPublish(() => {
      let old: string | null = null;
      if (present(dest)) {
        if (directory) {
          this.moveAside(dest);
        } else {
          old = stagedName(dest);
          fs.linkSync(dest, old);
        }
      }
      try {
        fs.renameSync(staging, dest);
      } catch (error) {
        throw old === null ? error : removing(old, error);
      }
      this.landed(dest, old);
    });
  }

  remove(file: string): void {
    this.afterPublish(() => this.moveAside(file));
  }

  // Check the settings and the record immediately before publication. Other
  // writers may still change either after this observation.
  expectText(file: string, was: string | null): void {
    this.afterPublish(() => {
      if (readTextIfPresent(file) !== was)
        throw new Error(
          `${file} changed while the install ran, so the install did not write it`,
        );
    });
  }

  writeText(file: string, was: string | null, will: string): void {
    this.expectText(file, was);
    if (was === will) return;
    const target = resolvedTarget(file);
    this.mkdir(path.dirname(target));
    this.replaceFile(target, will, filePermissions(target));
  }

  // Every change put back, newest first: the ones that could not be.
  undo(): UndoFailure[] {
    return this.log.undo();
  }

  // The install stands: the old copies go. Returns each that would not.
  finish(): string[] {
    for (const say of this.reports) say();
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
    this.kept.push(old);
    this.log.landed(file, () => {
      if (present(file))
        throw new Error(
          `the path is occupied; its previous contents are kept at ${old}`,
        );
      fs.renameSync(old, file);
    });
  }

  private landed(file: string, old: string | null): void {
    const installed = fs.lstatSync(file, { bigint: true });
    if (old !== null) this.kept.push(old);
    this.log.landed(file, () => {
      const current = fs.lstatSync(file, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (
        current?.dev !== installed.dev ||
        current.ino !== installed.ino ||
        current.ctimeNs !== installed.ctimeNs
      )
        throw new Error(
          `changed after publication; kept the current path${old === null ? "" : `; previous contents kept at ${old}`}`,
        );
      if (old === null) fs.rmSync(file, { recursive: true, force: true });
      else fs.renameSync(old, file);
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
    changes.publish();
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
