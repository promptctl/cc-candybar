import fs from "node:fs";
import path from "node:path";
import {
  asError,
  filePermissions,
  resolvedTarget,
  stagedName,
} from "../utils/atomic-write.js";
import { readTextIfPresent } from "../utils/regular-text.js";
import { InstallJournal, contentsOf, fileIdentity } from "./journal.js";

// [LAW:single-enforcer] Every change an install makes to the user's files,
// made so that a failed install puts it back. A replaced file or directory
// keeps its old self aside, under a name of its own beside it, until the
// install finishes; a text file is written only over the bytes the install
// planned from; a directory the install created is removed. Every name this
// makes is unique to the call, so nothing a failed run leaves can stand in
// the next run's way, and each one left is named.
export class InstallChanges {
  constructor(private readonly journal: InstallJournal) {}
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

  mkdir(dir: string, mode?: number): void {
    const missing: string[] = [];
    for (
      let target = path.resolve(dir);
      fileIdentity(target) === null;
      target = path.dirname(target)
    )
      missing.unshift(target);
    for (const file of missing) {
      this.journal.record({ op: "mkdir", file });
      fs.mkdirSync(file, { mode, recursive: true });
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
    this.journal.record({ op: "stage", file: staging });
    build(staging);
    const contents = contentsOf(staging);
    const installed = fileIdentity(staging)!;
    this.afterPublish(() => {
      const original = fileIdentity(dest);
      const old = original === null ? null : stagedName(dest);
      this.journal.record({
        op: "replace",
        file: dest,
        stage: staging,
        old,
        original,
        installed,
        contents,
      });
      if (old !== null) {
        if (directory) fs.renameSync(dest, old);
        else fs.linkSync(dest, old);
      }
      fs.renameSync(staging, dest);
    });
  }

  remove(file: string): void {
    this.afterPublish(() => {
      if (fileIdentity(file) === null) return;
      const old = stagedName(file);
      this.journal.record({ op: "remove", file, old });
      fs.renameSync(file, old);
    });
  }

  // Check the settings and the record immediately before publication. Other
  // writers may still change either after this observation.
  expectText(
    file: string,
    was: string | null,
    target = resolvedTarget(file),
  ): void {
    this.afterPublish(() => {
      if (resolvedTarget(file) !== target || readTextIfPresent(target) !== was)
        throw new Error(
          `${file} changed while the install ran, so the install did not write it`,
        );
    });
  }

  writeText(file: string, was: string | null, will: string): void {
    const target = resolvedTarget(file);
    this.expectText(file, was, target);
    if (was === will) return;
    this.mkdir(path.dirname(target));
    this.replaceFile(target, will, filePermissions(target));
  }

  reportSuccess(): void {
    for (const say of this.reports) say();
  }
}

// [LAW:no-silent-failure] An install whose step throws puts back every
// change it made, and its error says so, naming each it could not put back.
// One that stands removes the old copies, and names each that would not go.
export function transacted<T>(
  install: (changes: InstallChanges) => T,
  home?: string,
): T {
  const journal = InstallJournal.start(home);
  const changes = new InstallChanges(journal);
  let done: T;
  try {
    done = install(changes);
    changes.publish();
    journal.record({ op: "commit" });
  } catch (e) {
    const error = asError(e);
    let unrestored: string[];
    try {
      unrestored = journal.settle();
    } catch (recovery) {
      unrestored = [asError(recovery).message];
    }
    throw new Error(
      unrestored.length === 0
        ? `${error.message}\nThe install put back every change it made.`
        : `${error.message}\nThe install could not put back:\n${unrestored.join("\n")}`,
      { cause: error },
    );
  }
  journal.settle();
  changes.reportSuccess();
  return done;
}
