// [LAW:verifiable-goals] The dev tools as a developer runs them: each command
// from a plain shell, outside Jest, so nothing this worker's setup made is
// there to lean on. What the bar does is test/daemon-boots/worker/drive-bar.test.ts's
// and bar-web.test.ts's; here, that each tool starts and answers.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { DOOR_CLOSE_GLYPH, DOOR_GLYPH } from "../../../src/config/disclosure";
import { shellEnvironment } from "../../../scripts/lib/shell";
import { until } from "../../../scripts/lib/until";
import { checkoutAt } from "../../helpers/checkout";
import { daemonPool } from "../../helpers/spawn-test-daemon";
import { untilTestEnds } from "../../helpers/test-end";

jest.setTimeout(30_000);

// A shell's own, as a tool takes it (scripts/lib/shell.ts): no variable this
// worker's setup made.
const SHELL = shellEnvironment(process.env);
// Under the case's own budget, so a tool that hangs fails with what it said.
const TOOL_BUDGET_MS = 20_000;

// Where each tool draws its bar from, named as a developer can name it.
let checkout: string;
beforeAll(() => {
  checkout = checkoutAt(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-dev-tools-")));
});
afterAll(() => fs.rmSync(checkout, { recursive: true, force: true }));

const run = (args: string[]) =>
  promisify(execFile)("pnpm", ["-s", ...args], {
    cwd: process.cwd(),
    env: SHELL,
    timeout: TOOL_BUDGET_MS,
  });

// A tool that starts a daemon starts it outside the pool, so the case holds a
// slot for it: the suite's ceiling still counts every daemon it starts.
async function holdingASlot(body: () => Promise<void>): Promise<void> {
  const slot = await untilTestEnds((ended) =>
    daemonPool.acquire({ until: ended }),
  );
  try {
    await body();
  } finally {
    slot.release();
  }
}

test("pnpm bar draws the bar and follows a click on the door to the menu", () =>
  holdingASlot(async () => {
    const { stdout } = await run(["bar", "--cwd", checkout, DOOR_GLYPH]);
    const [closed, opened] = stdout.split(`--- ${DOOR_GLYPH}\n`);
    expect(closed).toContain("--- closed");
    expect(closed).not.toContain("🎨 look");
    expect(opened).toContain("🎨 look");
    expect(opened).toContain(DOOR_CLOSE_GLYPH);
  }));

test("pnpm bar:web serves the bar, and ctrl-c stops it", () =>
  holdingASlot(async () => {
    // Its own process group, as a terminal's foreground job is, so the
    // interrupt reaches pnpm and the server under it alike.
    const server = spawn("pnpm", ["-s", "bar:web", "--port", "0", "--cwd", checkout], {
      cwd: process.cwd(),
      env: SHELL,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let said = "";
    server.stdout.on("data", (chunk: Buffer) => (said += chunk.toString()));
    server.stderr.on("data", (chunk: Buffer) => (said += chunk.toString()));
    // How pnpm itself ends on the interrupt is its platform's: on macOS it
    // reports the server's own exit, on Linux it dies of the signal its group
    // got. That the job ended, and its server with it, holds on both.
    const exited = new Promise<void>((resolve) =>
      server.on("exit", () => resolve()),
    );
    const url = () => /the live bar: (\S+)/.exec(said)?.[1];
    try {
      await until(
        () => url() !== undefined,
        () => `bar:web naming its url; it said:\n${said}`,
        TOOL_BUDGET_MS,
      );
      const res = await fetch(new URL("/render", url()), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ width: 80, rows: 40 }),
      });
      expect(res.status).toBe(200);
      const view = (await res.json()) as { links: { text: string }[] };
      expect(view.links.map((l) => l.text)).toContain(DOOR_GLYPH);
    } finally {
      // A server that died on its way up has said why, which a signal to a
      // gone group would bury under ESRCH.
      if (server.exitCode === null && server.signalCode === null)
        process.kill(-server.pid!, "SIGINT");
    }
    await exited;
    await expect(
      fetch(new URL("/render", url()), { method: "POST", body: "{}" }),
    ).rejects.toThrow();
  }));

test("pnpm bench --list names the benchmarks", async () => {
  const { stdout } = await run(["bench", "--list"]);
  const ids = stdout
    .trim()
    .split("\n")
    .map((line) => line.split("  ")[0]);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) expect(id).toMatch(/^\S+$/);
});
