// [LAW:single-enforcer] The config files and repository decisions from one
// turn land together. Each rewrite carries the bytes its plan observed.
import fs from "node:fs";
import { asError, resolvedTarget, writeAtomic } from "../utils/atomic-write.js";

export interface FileRewrite {
  readonly file: string;
  readonly was: string | null;
  readonly will: string | null;
}

const writeText = (file: string, text: string | null): void =>
  text === null
    ? fs.rmSync(resolvedTarget(file), { force: true })
    : writeAtomic(file, text);

export function writeRevisions(
  rewrites: Iterable<FileRewrite>,
  retire: string | null,
): readonly string[] {
  const written: FileRewrite[] = [];
  try {
    for (const rewrite of rewrites) {
      writeText(rewrite.file, rewrite.will);
      written.push(rewrite);
    }
    const files = written.map(({ file }) => file);
    if (retire !== null) {
      // Retire the older directory entry itself, including when it is a
      // symlink. Nothing else can fail after this entry goes away.
      fs.rmSync(retire, { force: true });
      files.push(retire);
    }
    return files;
  } catch (cause) {
    const error = asError(cause);
    const failed: string[] = [];
    for (const { file, was } of written.reverse()) {
      try {
        writeText(file, was);
      } catch (rollback) {
        failed.push(asError(rollback).message);
      }
    }
    error.message +=
      failed.length === 0
        ? " — nothing was written"
        : `; and putting back what was written failed, so it is half-written: ${failed.join("; ")}`;
    throw error;
  }
}
