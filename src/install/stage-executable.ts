import fs from "node:fs";
import path from "node:path";
import { publishByRename } from "../utils/atomic-write.js";

export function stageExecutable(source: string, destination: string): void {
  if (path.resolve(source) === path.resolve(destination)) {
    fs.chmodSync(destination, 0o755);
    return;
  }
  // [LAW:single-enforcer] Both installers publish a fresh inode in one rename.
  // Darwin can keep the old inode's signature while an earlier exec still
  // has it mapped. Writing new bytes there can make the next launch SIGKILL.
  publishByRename(destination, fs.readFileSync(source), 0o755);
}
