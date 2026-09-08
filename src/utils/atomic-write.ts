import fs from "node:fs";

// [LAW:single-enforcer] The one tmp+rename for every file a user may be reading while we write it: a reader never sees a torn file, and without a `mode` the existing file's mode survives.
export function writeAtomic(file: string, text: string, mode?: number): void {
  const tmp = `${file}.tmp`;
  const fileMode = mode ?? fs.statSync(file, { throwIfNoEntry: false })?.mode;
  try {
    fs.writeFileSync(
      tmp,
      text,
      fileMode === undefined ? {} : { mode: fileMode },
    );
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
