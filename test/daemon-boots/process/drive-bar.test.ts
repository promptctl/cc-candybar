// [LAW:verifiable-goals] `pnpm bar` as a developer runs it: the command from a
// plain shell, outside Jest, so nothing this worker's setup made is there to
// lean on. The rest of test/daemon-boots/worker/drive-bar.test.ts is about the bar.

import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import { DOOR_CLOSE_GLYPH, DOOR_GLYPH } from "../../../src/config/disclosure";
import { daemonPool } from "../../helpers/spawn-test-daemon";

jest.setTimeout(30_000);

test("pnpm bar draws the bar and follows a click on the door to the menu", async () => {
  // The bar starts one daemon outside the pool, so the case holds a slot for
  // it: the suite's ceiling still counts every daemon it starts.
  const slot = await daemonPool.acquire();
  try {
    const { stdout } = await promisify(execFile)("pnpm", ["-s", "bar", DOOR_GLYPH], {
      cwd: process.cwd(),
      // A shell's own: where the tools live, the home and the temporary
      // directory. No variable this worker's setup made.
      env: { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: os.tmpdir() },
    });
    const [closed, opened] = stdout.split(`--- ${DOOR_GLYPH}\n`);
    expect(closed).toContain("--- closed");
    expect(closed).not.toContain("🎨 look");
    expect(opened).toContain("🎨 look");
    expect(opened).toContain(DOOR_CLOSE_GLYPH);
  } finally {
    slot.release();
  }
});
