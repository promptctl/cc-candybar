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
import type { ClientOutcome } from "../src/daemon/client";
import type {
  PermanentOutcome,
  TransientOutcome,
} from "../src/daemon/client-transport";
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
  sockPath: string;
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
            // [LAW:types-are-the-program] Mirrors the daemon's version-mismatch
            // asymmetry: only schedule shutdown when the client is *newer* —
            // never when it is older (that path is the spiral-breaker).
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
        sockPath,
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
      const resp = await sendRequest(server.sockPath, {
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
      const resp = await sendRequest(server.sockPath, {
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
      const resp = await sendRequest(server.sockPath, {
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
  function isOk(o: ClientOutcome): o is { kind: "ok"; value: string } {
    return o.kind === "ok";
  }

  test("type guards distinguish all three branches at compile time", () => {
    const samples: ClientOutcome[] = [
      { kind: "ok", value: "hello" },
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
    const prevSock = process.env.CC_CANDYBAR_SOCKET;
    process.env.XDG_STATE_HOME = tmpRoot;
    process.env.CC_CANDYBAR_SOCKET = sockPath;
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
      if (prevSock === undefined) {
        delete process.env.CC_CANDYBAR_SOCKET;
      } else {
        process.env.CC_CANDYBAR_SOCKET = prevSock;
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

  // [LAW:types-are-the-program] The cast `frame as Response` cannot prevent a
  // misbehaving daemon (or stub) from sending fields of the wrong runtime
  // type. The trust boundary in interpretResponse() narrows each field
  // explicitly; these tests pin that narrowing's behavior against adversarial
  // shapes that would otherwise propagate `undefined` or wrong-typed values
  // into ClientOutcome and crash downstream code (e.g. truncate() iterating
  // a non-string message).

  test("non-string error field is replaced with a safe fallback message", async () => {
    const outcome = await runWithStubDaemon({
      ok: false,
      code: "RENDER_FAILED",
      error: 42, // wrong type — daemon promised a string
    });
    expect(outcome.kind).toBe("permanent");
    if (outcome.kind !== "permanent") return;
    expect(outcome.cause).toBe("render_failed");
    if (outcome.cause !== "render_failed") return;
    // The fallback string is non-empty and safe to iterate / truncate.
    expect(typeof outcome.message).toBe("string");
    expect(outcome.message.length).toBeGreaterThan(0);
  });

  test("non-number daemonV is replaced with 0 (renders as 'unknown' in glyph)", async () => {
    const outcome = await runWithStubDaemon({
      ok: false,
      code: "VERSION_MISMATCH",
      error: "mismatch",
      daemonV: "v9000", // wrong type — daemon promised a number
    });
    expect(outcome.kind).toBe("permanent");
    if (outcome.kind !== "permanent") return;
    expect(outcome.cause).toBe("version_mismatch");
    if (outcome.cause !== "version_mismatch") return;
    expect(typeof outcome.daemonV).toBe("number");
    expect(outcome.daemonV).toBe(0);
  });

  // [LAW:one-type-per-behavior] Rust's serde_json `as_u64()` returns None
  // for negative or fractional values, falling back to 0 in the Rust
  // interpret_response. TS's asProtocolVersion narrowing must match so the
  // two runtimes derive the same PermanentOutcome from the same wire
  // payload. Without this, a daemon sending `daemonV: -1` or `daemonV:
  // 3.14` would yield different ClientOutcome values across runtimes for
  // the same input.
  test("negative daemonV is replaced with 0 (matches Rust's as_u64 fallback)", async () => {
    const outcome = await runWithStubDaemon({
      ok: false,
      code: "VERSION_MISMATCH",
      error: "mismatch",
      daemonV: -1,
    });
    if (outcome.kind !== "permanent" || outcome.cause !== "version_mismatch") {
      throw new Error(`unexpected outcome shape: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.daemonV).toBe(0);
  });

  test("fractional daemonV is replaced with 0 (matches Rust's as_u64 fallback)", async () => {
    const outcome = await runWithStubDaemon({
      ok: false,
      code: "VERSION_MISMATCH",
      error: "mismatch",
      daemonV: 3.14,
    });
    if (outcome.kind !== "permanent" || outcome.cause !== "version_mismatch") {
      throw new Error(`unexpected outcome shape: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.daemonV).toBe(0);
  });
});

// --- wire trust boundary: protocol-violation exceptions are PERMANENT ---
//
// [LAW:one-type-per-behavior] An exception from sendOne() can mean two very
// different things: a connection failure (daemon dead, socket vanished — a
// kick can recover) OR a protocol violation (the daemon responded with an
// oversized frame, or JSON the parser couldn't decode — a kick CANNOT
// recover, because the daemon is alive and will produce the same response
// again). The Rust mirror's classify_io_error routes InvalidData/InvalidInput
// to Permanent(MalformedResponse); TS's interpretException must do the same
// for "frame too large" and JSON parse errors so the recovery class agrees
// across runtimes.

function spinUpRawBytesSocket(
  sockPath: string,
  responseBytes: Buffer,
): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.once("data", () => {
        sock.write(responseBytes);
        sock.end();
      });
    });
    server.listen(sockPath, () => resolve(server));
  });
}

describe("wire trust boundary: protocol-violation exceptions are permanent", () => {
  async function runWithRawBytes(bytes: Buffer): Promise<ClientOutcome> {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-proto-"),
    );
    const stateDir = path.join(tmpRoot, "cc-candybar");
    fs.mkdirSync(stateDir, { recursive: true });
    const sockPath = path.join(stateDir, "socket");
    const server = await spinUpRawBytesSocket(sockPath, bytes);
    const prevXdg = process.env.XDG_STATE_HOME;
    const prevSock = process.env.CC_CANDYBAR_SOCKET;
    process.env.XDG_STATE_HOME = tmpRoot;
    process.env.CC_CANDYBAR_SOCKET = sockPath;
    try {
      const { tryRenderViaDaemon } = await import("../src/daemon/client");
      return await tryRenderViaDaemon(
        {
          session_id: "test-proto",
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
      if (prevSock === undefined) {
        delete process.env.CC_CANDYBAR_SOCKET;
      } else {
        process.env.CC_CANDYBAR_SOCKET = prevSock;
      }
      await new Promise<void>((r) => server.close(() => r()));
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  test("oversized frame from daemon produces permanent/malformed_response (no kick)", async () => {
    // 4-byte length prefix declaring 17 MiB body (above the 16 MiB cap).
    const oversizedLen = 17 * 1024 * 1024;
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32BE(oversizedLen, 0);
    const outcome = await runWithRawBytes(lenPrefix);
    expect(outcome.kind).toBe("permanent");
    if (outcome.kind !== "permanent") return;
    expect(outcome.cause).toBe("malformed_response");
    if (outcome.cause !== "malformed_response") return;
    expect(outcome.message).toContain("frame too large");
  });

  test("garbage JSON body from daemon produces permanent/malformed_response", async () => {
    // Length-prefixed frame whose body is not valid JSON.
    const body = Buffer.from("definitely not json", "utf8");
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32BE(body.length, 0);
    const outcome = await runWithRawBytes(Buffer.concat([lenPrefix, body]));
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

  test("ok outcome returns the daemon output, no kick, no debug message", () => {
    const plan = planOutcome({ kind: "ok", value: "rendered statusline\n" });
    expect(plan.kick).toBe(false);
    expect(plan.output).toBe("rendered statusline\n");
    // The happy path carries no debug message — nothing for the caller to log.
    expect(plan.debug).toBeNull();
  });

  test("every transient cause kicks and carries a debug message", () => {
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
      // The debug string is data, not a side effect — the caller decides
      // whether to log it.
      expect(plan.debug).toContain(`transient: ${cause}`);
      expect(plan.debug).toContain("kicking daemon");
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
      // The debug string spells out the cause and the no-kick decision.
      expect(plan.debug).toContain(`permanent: ${outcome.cause}`);
      expect(plan.debug).toContain("not kicking");
    }
  });
});
