import { heldClock } from "../helpers/held-clock";
import { memoryConnection } from "../../src/dial/dialer-fake";
import { PROTOCOL_VERSION } from "../../src/daemon/protocol";
import type { Response, StatsRequest } from "../../src/daemon/protocol";
import { versionGate } from "../../src/daemon/reply";
import type { HandledRequest } from "../../src/daemon/reply";
import { RENDER_BUDGETS, renderOutcomeOf } from "../../src/daemon/client";
import type { ClientOutcome } from "../../src/daemon/client";
import { exchangeOutcome } from "../../src/daemon/client-transport";
import type {
  PermanentOutcome,
  TransientOutcome,
} from "../../src/daemon/client-transport";
import { planOutcome } from "../../src/render/outcome-plan";

// [LAW:behavior-not-structure] The daemon's half of the contract is the
// version gate's reply: an older client gets VERSION_MISMATCH with daemonV
// and the daemon stays up; a newer client gets the same answer and the daemon
// exits once it flushes; a client at this version is admitted. These drive
// the real gate, and its log line is the operator's record of which it chose.

function gate(v: number): { reply: HandledRequest | null; logged: string[] } {
  const logged: string[] = [];
  const req: StatsRequest = { v, kind: "stats" };
  const reply = versionGate(
    req,
    (_level, msg) => logged.push(msg),
    PROTOCOL_VERSION,
  );
  return { reply, logged };
}

describe("daemon version-mismatch trigger asymmetry", () => {
  test("an older client is answered VERSION_MISMATCH with daemonV, and the daemon stays up", () => {
    const { reply, logged } = gate(PROTOCOL_VERSION - 1);
    // [LAW:types-are-the-program] The load-bearing half: an older client must
    // not stop the daemon, because the respawned daemon is at the same version
    // and the same client mismatches it again — the respawn spiral.
    expect(reply).toMatchObject({
      kind: "reply",
      resp: { ok: false, code: "VERSION_MISMATCH", daemonV: PROTOCOL_VERSION },
      exitAfterFlush: null,
    });
    expect(logged).toEqual([
      expect.stringContaining("client is stale — staying up"),
    ]);
  });

  test("a newer client is answered VERSION_MISMATCH, and the daemon exits once it flushes", () => {
    const { reply, logged } = gate(PROTOCOL_VERSION + 1);
    expect(reply).toMatchObject({
      kind: "reply",
      resp: { ok: false, code: "VERSION_MISMATCH", daemonV: PROTOCOL_VERSION },
      exitAfterFlush: 0,
    });
    expect(logged).toEqual([
      expect.stringContaining("binary likely upgraded — exiting"),
    ]);
  });

  test("a matching client is admitted: no reply, nothing logged", () => {
    expect(gate(PROTOCOL_VERSION)).toEqual({ reply: null, logged: [] });
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
// the message — explicit failure, mirrored on the Rust side. These cases
// exercise that boundary through renderOutcomeOf, the render path's entry to
// interpretResponse.

describe("wire trust boundary: unknown error codes (kz8.5 followup)", () => {
  // [LAW:effects-at-boundaries] What the client makes of a wire answer is
  // decided by renderOutcomeOf alone, so each case hands it the answer: there
  // is no listener whose accept a loaded loop can land after a budget.
  const outcomeOf = (response: object): ClientOutcome =>
    renderOutcomeOf(response as Response);

  test("unknown error code yields permanent/malformed_response with the code in the message", () => {
    const outcome = outcomeOf({
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

  test("missing code field yields permanent/malformed_response (does not crash)", () => {
    const outcome = outcomeOf({
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

  test("non-string error field is replaced with a safe fallback message", () => {
    const outcome = outcomeOf({
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

  test("non-number daemonV is replaced with 0 (renders as 'unknown' in glyph)", () => {
    const outcome = outcomeOf({
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
  test("negative daemonV is replaced with 0 (matches Rust's as_u64 fallback)", () => {
    const outcome = outcomeOf({
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

  test("fractional daemonV is replaced with 0 (matches Rust's as_u64 fallback)", () => {
    const outcome = outcomeOf({
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

describe("wire trust boundary: protocol-violation exceptions are permanent", () => {
  // [LAW:locality-or-seam] The daemon's end of an in-memory connection writes
  // `bytes` once it has read the request, and the client runs the real exchange
  // over the other end on a held clock: sendOne's reject path and the
  // classification are exercised as shipped, with no socket and no real timer.
  async function runWithRawBytes(bytes: Buffer): Promise<ClientOutcome> {
    const { daemonEnd, client } = memoryConnection();
    daemonEnd.once("data", () => {
      daemonEnd.write(bytes);
      daemonEnd.end();
    });
    return exchangeOutcome(
      client,
      heldClock(new Date("2026-01-01T00:00:00Z")),
      (deadline) => ({
        kind: "render",
        hookData: {
          session_id: "test-proto",
          workspace: { project_dir: "/tmp" },
          model: { id: "x", display_name: "X" },
        } as never,
        args: ["cc-candybar"],
        cwd: "/tmp",
        deadline,
      }),
      RENDER_BUDGETS,
      // No ok response arrives in these cases, so nothing is projected.
      (): string | undefined => undefined,
    );
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

  // The daemon answered, so it is up: a kick would spawn a candidate that
  // loses the bind to it. The Rust client's Busy variant agrees.
  test("a busy render does not kick: a daemon holds the socket", () => {
    const plan = planOutcome({
      kind: "busy",
      phase: "deadline",
      message: "anything",
    });
    expect(plan).toMatchObject({ kick: false, output: "\n" });
    expect(plan.debug).toContain("busy");
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
