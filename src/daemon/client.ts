import net from "node:net";
import type { ClaudeHookData } from "../utils/claude";
import { socketPath } from "./paths";
import { PROTOCOL_VERSION, sendOne } from "./protocol";
import type { Response } from "./protocol";

const CONNECT_TIMEOUT_MS = 50;
const TOTAL_BUDGET_MS = 150;
const CLICK_BUDGET_MS = 200;

// [LAW:types-are-the-program] The render outcome carries its own recovery
// semantics. `transient` failures mean the daemon was unavailable/slow —
// kicking a fresh daemon is the right response. `permanent` failures mean
// the daemon refused our request semantically — kicking does NOT help
// because the next daemon will refuse the same request the same way. The
// caller's branch is no longer uniform: it matches on `kind` and routes
// kick vs. show-error off the type, not off a stringified `reason`. This
// asymmetry was missing in the previous shape and is the root of the
// 452-corpse spiral (kz8.5).
export type ClientOutcome =
  | { kind: "ok"; output: string }
  | TransientOutcome
  | PermanentOutcome;

export interface TransientOutcome {
  kind: "transient";
  cause: "unreachable" | "timeout" | "io_error";
  message: string;
}

export type PermanentOutcome =
  | {
      kind: "permanent";
      cause: "version_mismatch";
      clientV: number;
      daemonV: number;
    }
  | { kind: "permanent"; cause: "bad_request"; message: string }
  | { kind: "permanent"; cause: "render_failed"; message: string }
  | { kind: "permanent"; cause: "malformed_response"; message: string };

// Try to render via the daemon. Returns a typed outcome — see ClientOutcome.
// There is no inline render path; see src/index.ts. The caller is responsible
// for branching on outcome.kind and deciding whether to kick, display an
// error glyph, or print the rendered output.
export async function tryRenderViaDaemon(
  hookData: ClaudeHookData,
  args: string[],
  cwd: string,
  termCols?: number,
): Promise<ClientOutcome> {
  let sock: net.Socket | null = null;
  try {
    sock = await connectWithTimeout(socketPath(), CONNECT_TIMEOUT_MS);
    const resp: Response = await sendOne(
      sock,
      {
        v: PROTOCOL_VERSION,
        kind: "render",
        hookData,
        args,
        cwd,
        termCols,
      },
      TOTAL_BUDGET_MS,
    );
    return interpretResponse(resp);
  } catch (e) {
    return interpretException(e);
  } finally {
    if (sock) sock.destroy();
  }
}

// [LAW:single-enforcer] Same outcome translator for click as for render —
// click failures decompose into the same transient/permanent split, so the
// caller's "ok? done : kick + fallback" logic gets the same typed input.
export async function tryClickViaDaemon(
  verb: string,
  value: string,
): Promise<ClientOutcome> {
  let sock: net.Socket | null = null;
  try {
    sock = await connectWithTimeout(socketPath(), CONNECT_TIMEOUT_MS);
    const resp: Response = await sendOne(
      sock,
      {
        v: PROTOCOL_VERSION,
        kind: "click",
        verb,
        value,
      },
      CLICK_BUDGET_MS,
    );
    return interpretResponse(resp);
  } catch (e) {
    return interpretException(e);
  } finally {
    if (sock) sock.destroy();
  }
}

// [LAW:types-are-the-program] One place that turns a wire-level Response
// into a typed ClientOutcome. Every caller of tryRender/tryClick goes through
// this, so the kick-vs-show-error decision has a single source of truth.
//
// [LAW:no-defensive-null-guards] This function sits AT the trust boundary —
// `resp` is `frame as Response`, an unchecked cast from socket JSON. The
// per-field type-narrowings and the default branch below are not defensive
// guards against an internal bug; they are the explicit handling at the
// wire edge for fields whose runtime types the JSON cast cannot enforce.
// Every untrusted access flows through asString/asNumber so the downstream
// ClientOutcome shape carries values of the declared types only.

// [LAW:single-enforcer] Narrowing primitives used everywhere we read a
// field off the cast `resp`. Centralised so a future "validate the whole
// frame" approach has one place to evolve from.
function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function interpretResponse(resp: Response): ClientOutcome {
  // Treat the cast `resp` as a bag of unknowns; each access is narrowed
  // explicitly. The typed parameter still documents the *expected* shape
  // for readers, but the runtime trusts only what it can verify per field.
  const raw = resp as {
    ok?: unknown;
    output?: unknown;
    error?: unknown;
    code?: unknown;
    daemonV?: unknown;
  };
  if (raw.ok === true) {
    if (typeof raw.output === "string") {
      return { kind: "ok", output: raw.output };
    }
    // Stats response to a render/click call — not our shape. Treat as a
    // permanent malformed-response so the caller does NOT kick (the daemon
    // is up, just answered the wrong question).
    return {
      kind: "permanent",
      cause: "malformed_response",
      message: "stats response to render/click",
    };
  }
  const errorMessage = asString(raw.error, "(no error message)");
  switch (raw.code) {
    case "VERSION_MISMATCH":
      return {
        kind: "permanent",
        cause: "version_mismatch",
        clientV: PROTOCOL_VERSION,
        // Older daemons may not echo daemonV; non-number values from a
        // misbehaving stub also fall back to 0 (the renderer maps 0 to
        // "unknown" in the visible glyph).
        daemonV: asNumber(raw.daemonV, 0),
      };
    case "TIMEOUT":
      // Daemon is alive but didn't answer in time — same recovery as
      // unreachable: kick and emit stale/blank. This is the *only* non-ok
      // wire code that maps to transient.
      return { kind: "transient", cause: "timeout", message: errorMessage };
    case "BAD_REQUEST":
      return { kind: "permanent", cause: "bad_request", message: errorMessage };
    case "RENDER_FAILED":
      return {
        kind: "permanent",
        cause: "render_failed",
        message: errorMessage,
      };
    default:
      // Unknown wire code — mirrors rust-client's `_ => MalformedResponse(...)`
      // so both runtimes converge on the same observable behavior for any
      // code the client doesn't recognize. String() handles missing /
      // non-string values without crashing.
      return {
        kind: "permanent",
        cause: "malformed_response",
        message: `unknown error code: ${String(raw.code)}`,
      };
  }
}

// Exceptions reaching this function come from two distinct classes:
//   - Connect/IO/timeout failures — transient. A respawn or retry has a
//     real chance of recovering (daemon dead, socket vanished, slow link).
//   - Protocol violations from sendOne's reject path — permanent. The
//     daemon is alive but produced garbage (oversized frame, JSON parse
//     failure). Respawning would hit the same response identically; this
//     is the same recovery class as a wire-level VERSION_MISMATCH, so we
//     route through PermanentCause::MalformedResponse and the user sees
//     a glyph naming the failure rather than a blank line plus a kick.
//
// [LAW:one-type-per-behavior] Mirrors rust-client's classify_io_error —
// InvalidData/InvalidInput map to Permanent(MalformedResponse), everything
// else stays transient. The two runtimes agree on the recovery class for
// every observable wire failure.
function interpretException(e: unknown): ClientOutcome {
  const message = e instanceof Error ? e.message : String(e);
  // Protocol violations from makeFrameReader / sendOne. "frame too large"
  // is emitted as a literal prefix by protocol.ts; JSON parse failures
  // surface as SyntaxError with these characteristic message stems on
  // modern V8. New parse-error wording would still be caught by the
  // SyntaxError name check below.
  if (
    message.startsWith("frame too large:") ||
    (e instanceof SyntaxError) ||
    message.includes("Unexpected token") ||
    message.includes("Unexpected end of JSON")
  ) {
    return { kind: "permanent", cause: "malformed_response", message };
  }
  if (message === "CONNECT_TIMEOUT" || message === "TIMEOUT") {
    return { kind: "transient", cause: "timeout", message };
  }
  if (
    message.includes("ECONNREFUSED") ||
    message.includes("ENOENT") ||
    message.includes("ENOTSOCK")
  ) {
    return { kind: "transient", cause: "unreachable", message };
  }
  return { kind: "transient", cause: "io_error", message };
}

function connectWithTimeout(
  path: string,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("CONNECT_TIMEOUT"));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
