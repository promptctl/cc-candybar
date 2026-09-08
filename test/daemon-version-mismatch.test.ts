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

// [LAW:behavior-not-structure] Assert the contract, not the daemon's shape.

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
            // [LAW:types-are-the-program] Shutdown only when the client is newer.
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
      const resp = await sendRequest(server.sockPath, {
        v: daemonV - 1,
        kind: "render",
      });
      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.code).toBe("VERSION_MISMATCH");
        expect(resp.daemonV).toBe(daemonV);
      }
      // [LAW:types-are-the-program] A stale client must never trigger shutdown.
      expect(server.shutdownObserved.triggered).toBe(false);
    } finally {
      await server.close();
    }
  });

  test("newer client receives VERSION_MISMATCH AND daemon triggers shutdown", async () => {
    const daemonV = PROTOCOL_VERSION;
    const server = await spinUpMismatchServer(daemonV);
    try {
      // A newer client means the daemon binary is stale; restart helps.
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

// [LAW:behavior-not-structure] The client's typed outcome is the contract.

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
    // [LAW:types-are-the-program] The kick-vs-not decision lives in the variant.
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

// [LAW:types-are-the-program] An unknown wire code must never return undefined.

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
        {},
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

  // [LAW:types-are-the-program] Wrong-typed wire fields are narrowed here.

  test("non-string error field is replaced with a safe fallback message", async () => {
    const outcome = await runWithStubDaemon({
      ok: false,
      code: "RENDER_FAILED",
      error: 42,
    });
    expect(outcome.kind).toBe("permanent");
    if (outcome.kind !== "permanent") return;
    expect(outcome.cause).toBe("render_failed");
    if (outcome.cause !== "render_failed") return;
    expect(typeof outcome.message).toBe("string");
    expect(outcome.message.length).toBeGreaterThan(0);
  });

  test("non-number daemonV is replaced with 0 (renders as 'unknown' in glyph)", async () => {
    const outcome = await runWithStubDaemon({
      ok: false,
      code: "VERSION_MISMATCH",
      error: "mismatch",
      daemonV: "v9000",
    });
    expect(outcome.kind).toBe("permanent");
    if (outcome.kind !== "permanent") return;
    expect(outcome.cause).toBe("version_mismatch");
    if (outcome.cause !== "version_mismatch") return;
    expect(typeof outcome.daemonV).toBe("number");
    expect(outcome.daemonV).toBe(0);
  });

  // [LAW:one-type-per-behavior] TS narrowing must match Rust's as_u64 fallback.
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

// [LAW:one-type-per-behavior] A protocol violation is permanent, not kickable.

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
        {},
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
    const body = Buffer.from("definitely not json", "utf8");
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32BE(body.length, 0);
    const outcome = await runWithRawBytes(Buffer.concat([lenPrefix, body]));
    expect(outcome.kind).toBe("permanent");
    if (outcome.kind !== "permanent") return;
    expect(outcome.cause).toBe("malformed_response");
  });
});

describe("planOutcome decides kick vs. no-kick per variant (kz8.5 chunk 1+4)", () => {
  // [LAW:behavior-not-structure] Permanent failures must never kick.

  test("ok outcome returns the daemon output, no kick, no debug message", () => {
    const plan = planOutcome({ kind: "ok", value: "rendered statusline\n" });
    expect(plan.kick).toBe(false);
    expect(plan.output).toBe("rendered statusline\n");
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
      expect(plan.output).toBe("\n");
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
      expect(plan.output).toContain("⚠ cc-candybar:");
      expect(plan.debug).toContain(`permanent: ${outcome.cause}`);
      expect(plan.debug).toContain("not kicking");
    }
  });
});
