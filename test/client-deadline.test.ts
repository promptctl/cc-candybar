// The Node client states when it will hang up (brandon-unfiled-3248.8ro6,
// §4c), and hangs up then: one instant, its budget counted from the connect,
// is both the `deadline` its render request carries and the one its own timer
// gives up at. A stub daemon reads what the client sent.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  encodeFrame,
  makeFrameReader,
  TOTAL_BUDGET_MS,
} from "../src/daemon/protocol";

// A daemon that hands every request it reads to `seen`, and answers it with
// `reply` — or, given none, never answers.
async function withStubDaemon<T>(
  reply: object | null,
  run: () => Promise<T>,
  seen: (req: Record<string, unknown>) => void,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-deadline-"));
  const sockPath = path.join(root, "cc-candybar", "socket");
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });
  const server = net.createServer((sock) => {
    sock.on(
      "data",
      makeFrameReader(
        (frame) => {
          seen(frame as Record<string, unknown>);
          if (reply !== null) sock.end(encodeFrame(reply));
        },
        (err) => {
          throw err;
        },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  const prev = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    CC_CANDYBAR_SOCKET: process.env.CC_CANDYBAR_SOCKET,
  };
  process.env.XDG_STATE_HOME = root;
  process.env.CC_CANDYBAR_SOCKET = sockPath;
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const render = async () => {
  const { tryRenderViaDaemon } = await import("../src/daemon/client");
  return tryRenderViaDaemon(
    {
      session_id: "deadline",
      workspace: { project_dir: "/tmp" },
      model: { id: "x", display_name: "X" },
    } as never,
    ["cc-candybar"],
    "/tmp",
    {},
  );
};

describe("the Node client's deadline", () => {
  test("a render request states the client's budget from the connect", async () => {
    let deadline: unknown;
    const before = Date.now();
    await expect(
      withStubDaemon({ ok: true, output: "bar" }, render, (req) => {
        deadline = req.deadline;
      }),
    ).resolves.toEqual({ kind: "ok", value: "bar" });
    const after = Date.now();
    expect(deadline).toBeGreaterThanOrEqual(before + TOTAL_BUDGET_MS);
    expect(deadline).toBeLessThanOrEqual(after + TOTAL_BUDGET_MS);
  });

  test("a client the daemon never answers gives up at the deadline it stated", async () => {
    let deadline = 0;
    const outcome = await withStubDaemon(null, render, (req) => {
      deadline = req.deadline as number;
    });
    const gaveUp = Date.now();
    expect(outcome).toMatchObject({ kind: "transient", cause: "timeout" });
    // Within the millisecond the two clocks round to.
    expect(gaveUp).toBeGreaterThanOrEqual(deadline - 1);
  });
});
