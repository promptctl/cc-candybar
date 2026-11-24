// [LAW:single-enforcer] The config files and repository decisions from one
// turn share a batch and its reverse-order restoration. Each rewrite carries
// the bytes its plan observed.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  asError,
  filePermissions,
  resolvedTarget,
  writeAtomic,
} from "../utils/atomic-write.js";
import type { SetAside, Unread } from "./foundations/stored-file.js";

export interface FileRewrite {
  readonly file: string;
  readonly was: string | null;
  readonly will: string | null;
}

// A superseded file goes to an unsearched name in its own directory. A
// separately edited older copy keeps its bytes, and a relative symlink
// continues pointing at the same destination.
export interface FileRetirement {
  readonly from: string;
  readonly to: string;
}

// [LAW:effects-at-boundaries] A publication replaces one file or leaves its
// prior bytes in place. Restoration uses the same operation as publication.
export type WriteConfigFile = (
  file: string,
  text: string | null,
  mode?: number,
) => void;

export const writeConfigFile: WriteConfigFile = (file, text, mode) =>
  text === null
    ? fs.rmSync(resolvedTarget(file), { force: true })
    : writeAtomic(file, text, mode);

// [LAW:single-enforcer] The one set-aside of a stored file that did not read,
// for every store that keeps one. What goes is the file its bytes sit in, a
// link's target, which is the file a write through the link would replace,
// and it goes to an unsearched name beside itself. So the link stays a link,
// and the next write creates a fresh target. Returns where the bytes went.
export function setAside(file: string): FileRetirement {
  const from = resolvedTarget(file);
  const to = `${from}.unread-${randomUUID()}`;
  fs.renameSync(from, to);
  return { from, to };
}

interface RestoreFailure {
  readonly file: string;
  readonly error: Error;
}

// [LAW:types-are-the-program] A failed publication with failed restorations
// carries the specific paths that need to be observed again.
export type RevisionWrite =
  | {
      readonly kind: "ok";
      readonly files: readonly string[];
      // Where the batch set an unread file aside, if it did.
      readonly setAside: SetAside | null;
    }
  | { readonly kind: "failed"; readonly error: Error }
  | {
      readonly kind: "incomplete";
      readonly error: Error;
      readonly unrestored: readonly [RestoreFailure, ...RestoreFailure[]];
    };

// One turn's batch: a state file that did not read, set aside before anything
// is written, the rewrites, and a superseded file retired after them.
export interface Revisions {
  readonly setAside: Unread | null;
  readonly rewrites: Iterable<FileRewrite>;
  readonly retire: FileRetirement | null;
}

export function writeRevisions(
  { setAside: unread, rewrites, retire }: Revisions,
  write: WriteConfigFile = writeConfigFile,
): RevisionWrite {
  const written: Array<
    FileRewrite & { readonly removedMode: number | undefined }
  > = [];
  // [LAW:no-ambient-temporal-coupling] The set-aside lands first, so no
  // rewrite can touch the bytes it keeps, and it is undone last.
  let aside: SetAside | null = null;
  try {
    if (unread !== null)
      aside = {
        file: unread.file,
        reason: unread.reason,
        ...setAside(unread.file),
      };
    for (const rewrite of rewrites) {
      // [LAW:effects-at-boundaries] A removed file loses its mode with its
      // directory entry. Capture it before unlink so restoration can stage
      // the original permissions before making the file visible again.
      const removedMode =
        rewrite.will === null && rewrite.was !== null
          ? filePermissions(rewrite.file)
          : undefined;
      write(rewrite.file, rewrite.will);
      written.push({ ...rewrite, removedMode });
    }
    const files = [
      ...(aside === null ? [] : [aside.to]),
      ...written.map(({ file }) => file),
    ];
    if (retire !== null) {
      // [LAW:single-enforcer] Retire the directory entry itself, even a
      // symlink. Nothing else can fail after this entry goes away.
      fs.renameSync(retire.from, retire.to);
      files.push(retire.from, retire.to);
    }
    return { kind: "ok", files, setAside: aside };
  } catch (cause) {
    const error = asError(cause);
    // [LAW:no-silent-failure] Try every restore and name each failure.
    const failed: RestoreFailure[] = [];
    for (const { file, was, will, removedMode } of written.reverse()) {
      // Removing a file already absent leaves no previous entry to restore.
      if (will === null && removedMode === undefined) continue;
      try {
        write(file, was, removedMode);
      } catch (rollback) {
        failed.push({ file, error: asError(rollback) });
      }
    }
    if (aside !== null)
      try {
        fs.renameSync(aside.to, aside.from);
      } catch (rollback) {
        // [LAW:no-silent-failure] The one path where the bytes stay aside:
        // the failure says where they are.
        const { message } = asError(rollback);
        failed.push({
          file: aside.from,
          error: new Error(`${message} — its bytes are kept at ${aside.to}`),
        });
      }
    const [first, ...remaining] = failed;
    return first === undefined
      ? { kind: "failed", error }
      : { kind: "incomplete", error, unrestored: [first, ...remaining] };
  }
}
