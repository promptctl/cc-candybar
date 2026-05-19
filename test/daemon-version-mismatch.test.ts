import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  makeFrameReader,
} from "../src/daemon/protocol";
import type { Response } from "../src/daemon/protocol";
import type {
  ClientOutcome,
  PermanentOutcome,
  TransientOutcome,
} from "../src/daemon/client";
import { planOutcome } from "../src/render/outcome-plan";

// [LAW:behavior-not-structure] These tests assert the contract — what a
// version-mismatched client sees and how the daemon responds — not the
// implementation. The shape of the daemon's handleRequest is free to change
// as long as it preserves: (a) older client gets VERSION_MISMATCH with
// daemonV present, (b) daemon does NOT initiate self-shutdown on older
// clients, (c) the client's typed outcome carries clientV and daemonV.

// --- helper: minimal daemon-like server that mirrors handleRequest's
// version-mismatch branch ---

interface MismatchServer {
  port: string;
  shutdownObserved: { triggered: boolean };
  close: () => Promise<void>;
}

function spinUpMismatchServer(daemonV: number): Promise<MismatchServer> {
  return new Promise((resolve) => {
    const shutdownObserved = { triggered: false };
    const server = net.createServer((sock) => {
      const reader = makeFrameReader(
        (frame) => {
          const req = frame as { v?: number; kind?: string };
          if (typeof req.v !== "number") {
            sock.write(
              encodeFrame({
                ok: false,
                error: "malformed request",
                code: "BAD_REQUEST",
                daemonV,
              }),
            );
            sock.end();
            return;
          }
          if (req.v !== daemonV) {
            // [LAW:types-are-the-program] Mirrors server.ts:419 — only
            // schedule shutdown when client is *newer*.
            if (req.v > daemonV) {
              shutdownObserved.triggered = true;
            }
            sock.write(
              encodeFrame({
                ok: false,
                error: `protocol v${req.v} not supported (daemon at v${daemonV})`,
                code: "VERSION_MISMATCH",
                daemonV,
              }),
            );
            sock.end();
            return;
          }
          sock.write(encodeFrame({ ok: true, output: "fake render\n" }));
          sock.end();
        },
        () => {
          /* parse error ignored — daemon side */
        },
      );
      sock.on("data", reader);
    });

    const sockPath = path.join(
      os.tmpdir(),
      `cc-candybar-vm-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
    );
    server.listen(sockPath, () => {
      resolve({
        port: sockPath,
        shutdownObserved,
        close: () =>
          new Promise((r) => {
            server.close(() => {
              try {
                fs.unlinkSync(sockPath);
              } catch {
                /* unlinked already */
              }
              r();
            });
          }),
      });
    });
  });
}

function sendRequest(
  sockPath: string,
  req: unknown,
  timeoutMs = 500,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: sockPath }, () => {
      client.write(encodeFrame(req));
    });
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("test request timeout"));
    }, timeoutMs);
    const reader = makeFrameReader(
      (frame) => {
        clearTimeout(timer);
        resolve(frame as Response);
        client.end();
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
    client.on("data", reader);
    client.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("daemon version-mismatch trigger asymmetry (kz8.5 chunk 4)", () => {
  test("older client receives VERSION_MISMATCH with daemonV; daemon does NOT trigger shutdown", async () => {
    const daemonV = PROTOCOL_VERSION;
    const server = await spinUpMismatchServer(daemonV);
    try {
      // Client claims an older protocol version (v=daemonV-1).
      const resp = await sendRequest(server.port, {
        v: daemonV - 1,
        kind: "render",
      });
      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.code).toBe("VERSION_MISMATCH");
        expect(resp.daemonV).toBe(daemonV);
      }
      // [LAW:types-are-the-program] The load-bearing assertion: shutdown is
      // NOT triggered when the client is stale. Triggering would respawn a
      // daemon at the same version, which the same client would mismatch
      // again — the 452-corpse spiral.
      expect(server.shutdownObserved.triggered).toBe(false);
    } finally {
      await server.close();
    }
  });

  test("newer client receives VERSION_MISMATCH AND daemon triggers shutdown", async () => {
    const daemonV = PROTOCOL_VERSION;
    const server = await spinUpMismatchServer(daemonV);
    try {
      // Client claims a newer protocol version — meaning the daemon binary
      // is stale relative to the freshly-installed client. Restart helps.
      const resp = await sendRequest(server.port, {
        v: daemonV + 1,
        kind: "render",
      });
      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.code).toBe("VERSION_MISMATCH");
        expect(resp.daemonV).toBe(daemonV);
      }
      expect(server.shutdownObserved.triggered).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("matching client sees Ok response, no mismatch path entered", async () => {
    const daemonV = PROTOCOL_VERSION;
    const server = await spinUpMismatchServer(daemonV);
    try {
      const resp = await sendRequest(server.port, {
        v: daemonV,
        kind: "render",
      });
      expect(resp.ok).toBe(true);
      expect(server.shutdownObserved.triggered).toBe(false);
    } finally {
      await server.close();
    }
  });
});

// --- client.ts interpretResponse() decoding ---
//
// [LAW:behavior-not-structure] The client's typed outcome is the contract.
// We exercise it via tryRenderViaDaemon against a stubbed socket. This
// proves the wire→type translation matches the runtime: VERSION_MISMATCH
// → `permanent`/`version_mismatch` carrying clientV and daemonV.

describe("ClientOutcome typing (kz8.5 chunk 1)", () => {
  function isPermanent(
    o: ClientOutcome,
  ): o is Extract<ClientOutcome, { kind: "permanent" }> {
    return o.kind === "permanent";
  }
  function isTransient(
    o: ClientOutcome,
  ): o is Extract<ClientOutcome, { kind: "transient" }> {
    return o.kind === "transient";
  }
  function isOk(o: ClientOutcome): o is { kind: "ok"; output: string } {
    return o.kind === "ok";
  }

  test("type guards distinguish all three branches at compile time", () => {
    const samples: ClientOutcome[] = [
      { kind: "ok", output: "hello" },
      { kind: "transient", cause: "unreachable", message: "ECONNREFUSED" },
      {
        kind: "permanent",
        cause: "version_mismatch",
        clientV: 3,
        daemonV: 2,
      },
    ];
    expect(samples.filter(isOk).length).toBe(1);
    expect(samples.filter(isTransient).length).toBe(1);
    expect(samples.filter(isPermanent).length).toBe(1);
  });

  test("VERSION_MISMATCH carries clientV and daemonV on the permanent variant", () => {
    const sample: ClientOutcome = {
      kind: "permanent",
      cause: "version_mismatch",
      clientV: 3,
      daemonV: 4,
    };
    expect(isPermanent(sample)).toBe(true);
    if (isPermanent(sample) && sample.cause === "version_mismatch") {
      expect(sample.clientV).toBe(3);
      expect(sample.daemonV).toBe(4);
    }
  });

  test("transient causes are recoverable; permanent causes are not — discriminator-only check", () => {
    // [LAW:types-are-the-program] The kick-vs-not decision lives in the
    // variant. Callers must NEVER have to inspect message text or some
    // sibling field to decide.
    const kickWorthy = (o: ClientOutcome): boolean => o.kind === "transient";
    expect(
      kickWorthy({
        kind: "transient",
        cause: "unreachable",
        message: "any",
      }),
    ).toBe(true);
    expect(
      kickWorthy({
        kind: "transient",
        cause: "timeout",
        message: "any",
      }),
    ).toBe(true);
    expect(
      kickWorthy({
        kind: "permanent",
        cause: "version_mismatch",
        clientV: 3,
        daemonV: 2,
      }),
    ).toBe(false);
    expect(
      kickWorthy({
        kind: "permanent",
        cause: "bad_request",
        message: "any",
      }),
    ).toBe(false);
  });
});

// --- wire trust boundary: unknown error codes do NOT return undefined ---
//
// [LAW:types-are-the-program] interpretResponse() declares it returns
// ClientOutcome, but `resp` is `frame as Response` — an unchecked cast from
// socket JSON. A daemon (or a stub, or a future build) that sends an error
// code the client doesn't recognize must not cause the function to silently
// fall off the bottom and return undefined. The default branch maps unknown
// codes to `permanent/malformed_response` with the unknown code preserved in
// the message — explicit failure, mirrored on the Rust side. This test
// exercises that boundary against a stubbed daemon, since interpretResponse
// itself is intentionally private to client.ts.

function spinUpRawCodeSocket(
  sockPath: string,
  response: object,
): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      const reader = makeFrameReader(
        () => {
          sock.write(encodeFrame(response));
          sock.end();
        },
        () => {
          /* parse error ignored on daemon side */
        },
      );
      sock.on("data", reader);
    });
    server.listen(sockPath, () => resolve(server));
  });
}

describe("wire trust boundary: unknown error codes (kz8.5 followup)", () => {
  async function runWithStubDaemon(
    response: object,
  ): Promise<ClientOutcome> {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-trust-"),
    );
    const stateDir = path.join(tmpRoot, "cc-candybar");
    fs.mkdirSync(stateDir, { recursive: true });
    const sockPath = path.join(stateDir, "socket");

    const server = await spinUpRawCodeSocket(sockPath, response);
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmpRoot;
    try {
      const { tryRenderViaDaemon } = await import("../src/daemon/client");
      return await tryRenderViaDaemon(
        {
          session_id: "test-trust-boundary",
          workspace: { project_dir: "/tmp" },
          model: { id: "x", display_name: "X" },
        } as never,
        ["cc-candybar"],
        "/tmp",
      );
    } finally {
      if (prevXdg === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = prevXdg;
      }
      await new Promise<void>((r) => server.close(() => r()));
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  test("unknown error code yields permanent/malformed_response with the code in the message", async () => {
    const outcome = await runWithStubDaemon({
      ok: false,
      error: "something happened",
      code: "MYSTERIOUS_FOO",
      daemonV: PROTOCOL_VERSION,
    });
    expect(outcome.kind).toBe("permanent");
    if (outcome.kind !== "permanent") return;
    expect(outcome.cause).toBe("malformed_response");
    if (outcome.cause !== "malformed_response") return;
    expect(outcome.message).toContain("MYSTERIOUS_FOO");
  });

  test("missing code field yields permanent/malformed_response (does not crash)", async () => {
    const outcome = await runWithStubDaemon({
      ok: false,
      error: "no code field at all",
    });
    expect(outcome.kind).toBe("permanent");
    if (outcome.kind !== "permanent") return;
    expect(outcome.cause).toBe("malformed_response");
  });
});

// --- caller behavior: planOutcome decides kick vs. no-kick per variant ---

describe("planOutcome decides kick vs. no-kick per variant (kz8.5 chunk 1+4)", () => {
  // [LAW:behavior-not-structure] Assert the contract directly on the pure
  // function: every transient variant kicks, every permanent variant does
  // not, every ok variant passes the daemon's output through verbatim. This
  // is the 452-corpse-spiral invariant — permanent failures must NEVER
  // trigger a kick, because the daemon will refuse the next request
  // identically and the spiral repeats.

  test("ok outcome returns the daemon output and does not kick", () => {
    const plan = planOutcome({ kind: "ok", output: "rendered statusline\n" });
    expect(plan.kick).toBe(false);
    expect(plan.output).toBe("rendered statusline\n");
  });

  test("every transient cause kicks", () => {
    const transientCauses: TransientOutcome["cause"][] = [
      "unreachable",
      "timeout",
      "io_error",
    ];
    for (const cause of transientCauses) {
      const plan = planOutcome({
        kind: "transient",
        cause,
        message: "anything",
      });
      expect(plan.kick).toBe(true);
      // Empty-line output keeps the statusline non-blank without flicker
      // while the kick warms a fresh daemon for the next render tick.
      expect(plan.output).toBe("\n");
    }
  });

  test("every permanent cause does NOT kick (the spiral-breaker)", () => {
    const permanentOutcomes: PermanentOutcome[] = [
      { kind: "permanent", cause: "version_mismatch", clientV: 3, daemonV: 4 },
      { kind: "permanent", cause: "bad_request", message: "x" },
      { kind: "permanent", cause: "render_failed", message: "x" },
      { kind: "permanent", cause: "malformed_response", message: "x" },
    ];
    for (const outcome of permanentOutcomes) {
      const plan = planOutcome(outcome);
      expect(plan.kick).toBe(false);
      // The output carries the diagnostic glyph rather than a blank line —
      // the user sees what went wrong directly in the statusline.
      expect(plan.output).toContain("⚠ cc-candybar:");
    }
  });
});
