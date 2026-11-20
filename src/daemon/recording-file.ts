import fs from "node:fs/promises";
import { stagedName } from "../utils/atomic-write.js";

export interface RecordingFile {
  append(line: string): Promise<void>;
  // A cleanup problem after publication leaves a successful, complete file.
  publish(): Promise<string | null>;
  discard(): Promise<void>;
}

// [LAW:effects-at-boundaries] The daemon writes only on request. Staging
// beside the destination lets a hard link publish the complete recording
// without replacing a file another process created in the meantime.
export async function openRecordingFile(file: string): Promise<RecordingFile> {
  try {
    await fs.lstat(file);
    throw new Error("recording destination already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staged = stagedName(file);
  const handle = await fs.open(staged, "wx", 0o600);
  return {
    append: (line) => handle.writeFile(line, "utf8"),
    publish: async () => {
      await handle.close();
      await fs.link(staged, file);
      try {
        await fs.unlink(staged);
        return null;
      } catch (error) {
        return `could not remove staged recording ${staged}: ${String(error)}`;
      }
    },
    discard: async () => {
      try {
        await handle.close();
      } finally {
        await fs.rm(staged, { force: true });
      }
    },
  };
}
