// The Node client states when it will hang up (brandon-unfiled-3248.8ro6,
// §4c), and hangs up then: one instant, across negotiation and both connects,
// is both the `deadline` its render request carries and the one its own timer
// gives up at. A stub daemon reads what the client sent.

import fs from "node:fs";
import { hostOf } from "./helpers/host";
import type { Host } from "../src/host";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { RENDER_BUDGETS } from "../src/daemon/client";
import type { RoundTripBudgets } from "../src/daemon/client-transport";
import {
  CONNECT_TIMEOUT_MS,
  encodeFrame,
  makeFrameReader,
  TOTAL_BUDGET_MS,
} from "../src/daemon/foundations/protocol";
import { systemTimekeeper } from "./helpers/system-clock";

// A daemon that hands every request it reads to `seen`, and answers it with
// `reply` — or, given none, never answers.
async function withStubDaemon<T>(
  reply: object | ((req: Record<string, unknown>) => object) | null,
  run: (host: Host) => Promise<T>,
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
          const req = frame as Record<string, unknown>;
          seen(req);
          const answer = typeof reply === "function" ? reply(req) : reply;
          if (answer !== null) sock.end(encodeFrame(answer));
          return "done";
        },
        (err) => {
          throw err;
        },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  const host = hostOf({
    SESSION_MARKER: "synthetic-session",
    SSH_CLIENT: "test-client",
    XDG_STATE_HOME: root,
    CC_CANDYBAR_SOCKET: sockPath,
  });
  try {
    return await run(host);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// [LAW:no-ambient-temporal-coupling] The stub serves on this worker's own event
// loop, so on a loaded runner its accept can land after the statusline's 50 ms
// connect budget and the client answers CONNECT_TIMEOUT. What these cases
// prove is the deadline a request states and the client keeps, not that a
// loaded loop is fast, so they state budgets no loop delay reaches. The
// statusline's own are a wire fact, asserted once below.
const render = (budgets: RoundTripBudgets) => async (host: Host) => {
  const { tryRenderViaDaemon } = await import("../src/daemon/client");
  return tryRenderViaDaemon(
    { host, clock: systemTimekeeper },
    {
      session_id: "deadline",
      workspace: { project_dir: "/tmp" },
      model: { id: "x", display_name: "X" },
    } as never,
    ["cc-candybar"],
    "/tmp",
    {},
    budgets,
  );
};

describe("the Node client's deadline", () => {
  test("the statusline's budgets are the wire facts", () => {
    expect(RENDER_BUDGETS).toEqual({
      connectMs: CONNECT_TIMEOUT_MS,
      budgetMs: TOTAL_BUDGET_MS,
    });
  });

  test("a render request states the client's budget from the start of the attempt", async () => {
    const budgets = { connectMs: 5_000, budgetMs: 2_000 };
    let deadline: unknown;
    const before = Date.now();
    await expect(
      withStubDaemon({ ok: true, output: "bar" }, render(budgets), (req) => {
        deadline = req.deadline;
      }),
    ).resolves.toEqual({ kind: "ok", value: "bar" });
    const after = Date.now();
    expect(deadline).toBeGreaterThanOrEqual(before + budgets.budgetMs);
    expect(deadline).toBeLessThanOrEqual(after + budgets.budgetMs);
  });

  test.each([
    { ok: true, need: "environment" },
    { ok: false, code: "BAD_REQUEST", error: "unknown kind" },
  ])(
    "supplies the environment once at the original deadline on %j",
    async (firstReply) => {
      const wire: Record<string, unknown>[] = [];
      await expect(
        withStubDaemon(
          (req) =>
            req.kind === "render-session"
              ? firstReply
              : { ok: true, output: "ready" },
          render({ connectMs: 5000, budgetMs: 2000 }),
          (req) => wire.push(req),
        ),
      ).resolves.toEqual({ kind: "ok", value: "ready" });
      expect(wire).toHaveLength(2);
      const [compact, full] = wire;
      expect(compact).toMatchObject({
        kind: "render-session",
        envKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(Object.keys(compact!).sort()).toEqual([
        "args",
        "cwd",
        "deadline",
        "envKey",
        "hookData",
        "kind",
        "v",
      ]);
      expect(full).toMatchObject({
        kind: "render",
        envKey: compact!.envKey,
        deadline: compact!.deadline,
        env: { SESSION_MARKER: "synthetic-session" },
      });
      if (firstReply.ok) expect(full).not.toHaveProperty("ssh");
      else expect(full?.ssh).toBe(true);
    },
  );

  test.each([
    [
      { ok: true, output: "environment" },
      { kind: "ok", value: "environment" },
    ],
    [
      { ok: false, code: "BAD_REQUEST", error: "bad hook" },
      { kind: "permanent", cause: "bad_request" },
    ],
    [
      { ok: false, code: "TIMEOUT", error: "late" },
      { kind: "busy", phase: "backstop" },
    ],
  ])(
    "a completed or ambiguous attempt sends just the compact frame",
    async (reply, outcome) => {
      const seen: unknown[] = [];
      await expect(
        withStubDaemon(
          reply,
          render({ connectMs: 5000, budgetMs: 2000 }),
          (req) => seen.push(req),
        ),
      ).resolves.toMatchObject(outcome);
      expect(seen).toHaveLength(1);
    },
  );

  test("a repeated challenge has no third attempt", async () => {
    const seen: unknown[] = [];
    await expect(
      withStubDaemon(
        { ok: true, need: "environment" },
        render({ connectMs: 5000, budgetMs: 2000 }),
        (req) => seen.push(req),
      ),
    ).resolves.toMatchObject({
      kind: "permanent",
      cause: "malformed_response",
    });
    expect(seen).toHaveLength(2);
  });

  test("a client the daemon never answers gives up at the deadline it stated", async () => {
    let deadline = 0;
    const outcome = await withStubDaemon(
      null,
      render({ connectMs: 5_000, budgetMs: 1_000 }),
      (req) => {
        deadline = req.deadline as number;
      },
    );
    const gaveUp = Date.now();
    // Its own deadline timer, not the connect's: the request reached the stub
    // and the client waited for an answer it never got.
    // Busy, not transient: a daemon accepted the request, so a kick's
    // candidate would lose the bind to it.
    expect(outcome).toEqual({
      kind: "busy",
      phase: "deadline",
      message: "TIMEOUT",
    });
    expect(deadline).toBeGreaterThan(0);
    // Within the millisecond the two clocks round to.
    expect(gaveUp).toBeGreaterThanOrEqual(deadline - 1);
  });
});
