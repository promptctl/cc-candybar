// [LAW:effects-at-boundaries] A file the host writes for another process,
// which streams its text over the host's lines and opens no file itself.

import fs from "node:fs";
import { once } from "node:events";

// `stream`'s chunks written to `file`, a new file and owner-only, opened
// before `stream` is called: a file that cannot be made asks nothing of the
// process. [LAW:no-silent-failure] A write that fails is the call's failure
// once the stream ends; the chunks after it are dropped, since the file is
// lost already.
export async function streamedToFile(
  file: string,
  stream: (write: (chunk: string) => void) => Promise<void>,
): Promise<void> {
  const out = fs.createWriteStream(file, { flags: "wx", mode: 0o600 });
  await once(out, "open");
  let failed: unknown = null;
  out.on("error", (e) => (failed ??= e));
  try {
    await stream((chunk) => {
      if (failed === null) out.write(chunk);
    });
  } finally {
    // Settled once every write has landed, or with why one did not.
    await new Promise<void>((settled) =>
      out.end((e?: Error | null) => {
        if (e) failed ??= e;
        settled();
      }),
    );
  }
  if (failed !== null) throw failed;
}
