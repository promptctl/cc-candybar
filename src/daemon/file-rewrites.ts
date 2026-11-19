// [LAW:single-enforcer] The config files and repository decisions from one
// turn share a batch and its reverse-order restoration. Each rewrite carries
// the bytes its plan observed.
import fs from "node:fs";
import { asError, resolvedTarget, writeAtomic } from "../utils/atomic-write.js";

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
export type WriteConfigFile = (file: string, text: string | null) => void;

export const writeConfigFile: WriteConfigFile = (file, text) =>
  text === null
    ? fs.rmSync(resolvedTarget(file), { force: true })
    : writeAtomic(file, text);

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

export function writeRevisions(
  rewrites: Iterable<FileRewrite>,
  retire: FileRetirement | null,
  write: WriteConfigFile = writeConfigFile,
): RevisionWrite {
  const written: FileRewrite[] = [];
  try {
    for (const rewrite of rewrites) {
      write(rewrite.file, rewrite.will);
      written.push(rewrite);
    }
    const files = written.map(({ file }) => file);
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
    for (const { file, was } of written.reverse()) {
      try {
        write(file, was);
      } catch (rollback) {
        failed.push({ file, error: asError(rollback) });
      }
    }
    const [first, ...remaining] = failed;
    return first === undefined
      ? { kind: "failed", error }
      : { kind: "incomplete", error, unrestored: [first, ...remaining] };
  }
}
