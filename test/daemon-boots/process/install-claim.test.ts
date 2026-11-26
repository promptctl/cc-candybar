// Two Node processes contend for the same user's install. SIGKILL prevents
// the first one's finally block from running, as a crashed installer would.
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processWorld } from "../../../src/host";
import { withInstallClaim } from "../../../src/install/claim";

test("a live install excludes a second process, and its exit releases the claim", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-claim-"));
  const held = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import fs from "node:fs";
       import {processWorld} from "./src/host.ts";
       import {withInstallClaim} from "./src/install/claim.ts";
       withInstallClaim(process.argv[1], processWorld().launcher, () => {
         fs.writeSync(1, "holding");
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
       });`,
      dir,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(held, "close");
  const stderr: Buffer[] = [];
  held.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  try {
    const ready = await Promise.race([
      once(held.stdout, "data").then(([chunk]) => String(chunk)),
      exited.then(([code]) => {
        throw new Error(`holder exited ${code}: ${Buffer.concat(stderr)}`);
      }),
    ]);
    expect(ready).toBe("holding");
    const retry = () =>
      withInstallClaim(dir, processWorld().launcher, () => "installed");
    expect(retry).toThrow(/Another install holds/);
    held.kill("SIGKILL");
    await exited;
    expect(retry()).toBe("installed");
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    held.kill("SIGKILL");
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
