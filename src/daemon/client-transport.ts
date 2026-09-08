// [LAW:one-type-per-behavior] The one client-side daemon round-trip; a new caller
// is a new argument set, not a new branch.

import net from "node:net";
import { socketPath } from "./paths";
import { PROTOCOL_VERSION, ProtocolError, sendOne } from "./protocol";
import type { Request, Response } from "./protocol";

// Per-caller timeout policy carried as data: the render path runs tighter budgets.
export interface RoundTripBudgets {
  readonly connectMs: number;
  readonly budgetMs: number;
}

// [LAW:types-are-the-program] The outcome carries its recovery semantics:
// `transient` means kick a fresh daemon; `permanent` means the next refuses alike.
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

// [LAW:single-enforcer] The protocol version is stamped here, on every request.
type Unversioned<R> = R extends { v: number } ? Omit<R, "v"> : never;
export type UnversionedRequest = Unversioned<Request>;

type OkResponse = Extract<Response, { ok: true }>;

// `project` returning undefined maps to permanent/malformed_response, not a kick.
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

// [LAW:no-defensive-null-guards] AT the trust boundary: `resp` is an unchecked cast
// from socket JSON, so each field is narrowed rather than guarded.

// [LAW:single-enforcer] Narrowing primitives for every field read off the cast.
function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

// [LAW:one-type-per-behavior] Mirrors Rust's `as_u64()`: non-negative integers only.
function asProtocolVersion(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

function interpretResponse<T>(
  kind: Request["kind"],
  resp: Response,
  project: (resp: OkResponse) => T | undefined,
): RoundTripOutcome<T> {
  // The typed parameter documents the expected shape; the runtime trusts per field.
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
    // The daemon is up, just answered the wrong question — permanent, so no kick.
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
        // Older daemons may not echo daemonV; 0 renders as "unknown".
        daemonV: asProtocolVersion(raw.daemonV),
      };
    case "TIMEOUT":
      // The only non-ok wire code that maps to transient.
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
      // Mirrors rust-client's `_ => MalformedResponse(...)` for unknown codes.
      return {
        kind: "permanent",
        cause: "malformed_response",
        message: `unknown error code: ${String(raw.code)}`,
      };
  }
}

// [LAW:types-are-the-program] The protocol-violation discriminator is structural
// (`ProtocolError`), never a substring match. Mirrors rust-client's classify_io_error.
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

// [LAW:single-enforcer] One plain-text rendering; the spawn hint is transient-only.
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
