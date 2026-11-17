// [LAW:effects-at-boundaries] A file the host writes for another process,
// which streams its text over the host's lines and opens no file itself.

import fs from "node:fs";

// `stream`'s chunks written to `file`, a new file and owner-only, opened
// before `stream` is called: a file that cannot be made asks nothing of the
// process. Each chunk is on the disk before the host reads its next line, so
// the host holds one chunk at a time and a disk slower than the pipe leaves
// the rest unread in the pipe, never in the host's heap, which a breach has
// already put over its limit. [LAW:no-silent-failure] A write that fails is
// the call's failure once the stream ends; the chunks after it are dropped,
// since the file is lost already.
export async function streamedToFile(
  file: string,
  stream: (write: (chunk: string) => void) => Promise<void>,
): Promise<void> {
  const fd = fs.openSync(file, "wx", 0o600);
  let failed: unknown = null;
  try {
    await stream((chunk) => {
      if (failed !== null) return;
      try {
        fs.writeSync(fd, chunk);
      } catch (e) {
        failed = e;
      }
    });
  } finally {
    fs.closeSync(fd);
  }
  if (failed !== null) throw failed;
}
