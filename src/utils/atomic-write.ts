import fs from "node:fs";

// [LAW:single-enforcer] The one tmp+rename for every file a user may be
// reading while we write it — the config file, its edit history, and Claude
// Code's settings.json (the doctor fix and `install`): a reader never sees a
// torn file, and a rename that fails leaves no orphaned tmp behind. Without a
// `mode` the existing file's mode survives (a hand-authored file keeps
// whatever the user gave it) and a first-ever file takes the process umask.
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
