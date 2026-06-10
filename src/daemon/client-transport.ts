// The single client-side daemon socket round-trip: connect with a timeout,
// send one framed request, await one framed response, always destroy the
// socket, and classify every failure into the transient/permanent split.
//
// [LAW:one-type-per-behavior] This round-trip used to be implemented three
// times (render/click in client.ts, stats in client-stats.ts, debug in
// client-debug.ts), differing only in timeout values and which payload field
// the caller wanted — configuration, not behavior. Callers now pass their
// budgets and payload projector as VALUES through this one boundary; the
// stats/debug paths inherited classification fixes (post-2l6) they had
// silently drifted away from. [LAW:dataflow-not-control-flow] There is no
// caller-identity flag here — a new caller is a new argument set, not a new
// branch.

import net from "node:net";
import { socketPath } from "./paths";
import { PROTOCOL_VERSION, ProtocolError, sendOne } from "./protocol";
import type { Request, Response } from "./protocol";

// Per-caller timeout policy, carried as data. The render hot path runs tight
// budgets (a statusline refresh must not stall the host); operator-driven
// CLIs (stats/debug) legitimately afford slower ones.
export interface RoundTripBudgets {
  readonly connectMs: number;
  readonly budgetMs: number;
}

// [LAW:types-are-the-program] The outcome carries its own recovery
// semantics. `transient` failures mean the daemon was unavailable/slow —
// kicking a fresh daemon is the right response. `permanent` failures mean
// the daemon refused our request semantically — kicking does NOT help
// because the next daemon will refuse the same request the same way. The
// caller's branch is no longer uniform: it matches on `kind` and routes
// kick vs. show-error off the type, not off a stringified `reason`. This
// asymmetry was missing in the previous shape and is the root of the
// 452-corpse spiral (kz8.5).
export type RoundTripOutcome<T> = { kind: "ok"; value: T } | FailureOutcome;

export type FailureOutcome = TransientOutcome | PermanentOutcome;

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

// [LAW:single-enforcer] The protocol version is stamped here, on every
// outbound request — a caller cannot mis-stamp or omit it.
type Unversioned<R> = R extends { v: number } ? Omit<R, "v"> : never;
export type UnversionedRequest = Unversioned<Request>;

type OkResponse = Extract<Response, { ok: true }>;

// One round-trip, classified. `project` extracts the caller's payload from
// an ok response and returns undefined when the response, though ok, does
// not carry the expected shape (the daemon is up, it just answered the
// wrong question) — that maps to permanent/malformed_response, not a kick.
// The payload types themselves never enter this module [LAW:one-way-deps].
export async function requestOutcome<T>(
  req: UnversionedRequest,
  budgets: RoundTripBudgets,
  project: (resp: OkResponse) => T | undefined,
): Promise<RoundTripOutcome<T>> {
  let sock: net.Socket | null = null;
  try {
    sock = await connectWithTimeout(socketPath(), budgets.connectMs);
    const resp: Response = await sendOne(
      sock,
      { v: PROTOCOL_VERSION, ...req },
      budgets.budgetMs,
    );
    return interpretResponse(req.kind, resp, project);
  } catch (e) {
    return interpretException(e);
  } finally {
    if (sock) sock.destroy();
  }
}

// [LAW:types-are-the-program] One place that turns a wire-level Response
// into a typed Outcome. Every daemon client goes through this, so the
// kick-vs-show-error decision has a single source of truth.
//
// [LAW:no-defensive-null-guards] This function sits AT the trust boundary —
// `resp` is `frame as Response`, an unchecked cast from socket JSON. The
// per-field type-narrowings and the default branch below are not defensive
// guards against an internal bug; they are the explicit handling at the
// wire edge for fields whose runtime types the JSON cast cannot enforce.
// Every untrusted access flows through asString/asProtocolVersion so the
// downstream Outcome shape carries values of the declared types only.

// [LAW:single-enforcer] Narrowing primitives used everywhere we read a
// field off the cast `resp`. Centralised so a future "validate the whole
// frame" approach has one place to evolve from. Each helper expresses an
// exact type predicate; mixing semantics (e.g. "any finite number" with
// "non-negative integer") would weaken the type [LAW:types-are-the-program].
function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

// [LAW:one-type-per-behavior] Mirrors the Rust client's `as_u64()` semantics:
// the only valid daemonV values are non-negative integers. Negatives and
// fractional values fall back to 0 so both runtimes derive the same
// PermanentOutcome from the same wire payload.
function asProtocolVersion(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

function interpretResponse<T>(
  kind: Request["kind"],
  resp: Response,
  project: (resp: OkResponse) => T | undefined,
): RoundTripOutcome<T> {
  // Treat the cast `resp` as a bag of unknowns; each access is narrowed
  // explicitly. The typed parameter still documents the *expected* shape
  // for readers, but the runtime trusts only what it can verify per field.
  const raw = resp as {
    ok?: unknown;
    error?: unknown;
    code?: unknown;
    daemonV?: unknown;
  };
  if (raw.ok === true) {
    const value = project(resp as OkResponse);
    if (value !== undefined) {
      return { kind: "ok", value };
    }
    // Ok response without the payload this request asked for — not our
    // shape. Treat as a permanent malformed-response so the caller does NOT
    // kick (the daemon is up, just answered the wrong question).
    return {
      kind: "permanent",
      cause: "malformed_response",
      message: `ok response without payload for "${kind}" request`,
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
        daemonV: asProtocolVersion(raw.daemonV),
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
// [LAW:types-are-the-program] The protocol-violation discriminator is
// carried structurally by `ProtocolError` (exported from protocol.ts) —
// not by substring-matching the error message, which would silently drift
// if Node's JSON.parse wording changes across versions/locales. The
// `e instanceof SyntaxError` fallback covers a residual case where a
// JSON.parse happened to escape `makeFrameReader`'s wrapping (defense in
// depth, not the primary path).
//
// [LAW:one-type-per-behavior] Mirrors rust-client's classify_io_error —
// InvalidData/InvalidInput map to Permanent(MalformedResponse), everything
// else stays transient. The two runtimes agree on the recovery class for
// every observable wire failure.
function interpretException(e: unknown): FailureOutcome {
  if (e instanceof ProtocolError || e instanceof SyntaxError) {
    const message = e instanceof Error ? e.message : String(e);
    return { kind: "permanent", cause: "malformed_response", message };
  }
  const message = e instanceof Error ? e.message : String(e);
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

// [LAW:single-enforcer] One plain-text rendering of a failed outcome for
// operator-facing CLIs (daemon-stats, vars/segments/config). The statusline
// glyph (src/render/error-glyph.ts) and the url-handle formatter
// (src/install/index.ts) are deliberately separate presentations with their
// own contracts (ANSI styling and Rust-parity truncation; per-cause click
// diagnostics). The spawn hint appears only on transient failures — on a
// permanent failure the daemon is demonstrably running, and suggesting a
// respawn would send the operator down the wrong path.
export function describeFailure(outcome: FailureOutcome): string {
  if (outcome.kind === "transient") {
    return (
      `daemon unavailable (${outcome.cause}: ${outcome.message})\n` +
      "Hint: daemon may not be running. Run `cc-candybar` once to spawn it."
    );
  }
  switch (outcome.cause) {
    case "version_mismatch": {
      const daemon = outcome.daemonV === 0 ? "unknown" : `v${outcome.daemonV}`;
      return `daemon protocol mismatch (client v${outcome.clientV} ≠ daemon ${daemon})`;
    }
    case "bad_request":
    case "render_failed":
    case "malformed_response":
      return `daemon error (${outcome.cause}): ${outcome.message}`;
  }
}
