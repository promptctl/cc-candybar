// [LAW:single-enforcer] The config files and repository decisions from one
// turn share a batch and its reverse-order restoration. Each rewrite carries
// the bytes its plan observed.
import fs from "node:fs";
import {
  asError,
  filePermissions,
  resolvedTarget,
  writeAtomic,
} from "../utils/atomic-write.js";

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

interface RestoreFailure {
  readonly file: string;
  readonly error: Error;
}

// [LAW:types-are-the-program] A failed publication with failed restorations
// carries the specific paths that need to be observed again.
export type RevisionWrite =
  | { readonly kind: "ok"; readonly files: readonly string[] }
  | { readonly kind: "failed"; readonly error: Error }
  | {
      readonly kind: "incomplete";
      readonly error: Error;
      readonly unrestored: readonly [RestoreFailure, ...RestoreFailure[]];
    };

// One turn's batch: a state file that did not read, set aside before anything
// is written, the rewrites, and a superseded file retired after them.
export interface Revisions {
  readonly setAside: FileRetirement | null;
  readonly rewrites: Iterable<FileRewrite>;
  readonly retire: FileRetirement | null;
}

export function writeRevisions(
  { setAside, rewrites, retire }: Revisions,
  write: WriteConfigFile = writeConfigFile,
): RevisionWrite {
  const written: Array<
    FileRewrite & { readonly removedMode: number | undefined }
  > = [];
  // [LAW:no-ambient-temporal-coupling] The set-aside lands first, so no
  // rewrite can touch the bytes it keeps, and it is undone last.
  let asideNow: FileRetirement | null = null;
  try {
    if (setAside !== null) {
      fs.renameSync(setAside.from, setAside.to);
      asideNow = setAside;
    }
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
      ...(setAside === null ? [] : [setAside.to]),
      ...written.map(({ file }) => file),
    ];
    if (retire !== null) {
      // [LAW:single-enforcer] Retire the directory entry itself, even a
      // symlink. Nothing else can fail after this entry goes away.
      fs.renameSync(retire.from, retire.to);
      files.push(retire.from, retire.to);
    }
    return { kind: "ok", files };
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
    if (asideNow !== null)
      try {
        fs.renameSync(asideNow.to, asideNow.from);
      } catch (rollback) {
        failed.push({ file: asideNow.from, error: asError(rollback) });
      }
    const [first, ...remaining] = failed;
    return first === undefined
      ? { kind: "failed", error }
      : { kind: "incomplete", error, unrestored: [first, ...remaining] };
  }
}
