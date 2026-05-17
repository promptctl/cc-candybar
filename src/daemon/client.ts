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
function interpretResponse(resp: Response): ClientOutcome {
  if (resp.ok) {
    if ("output" in resp) return { kind: "ok", output: resp.output };
    // Stats response to a render/click call — not our shape. Treat as a
    // permanent malformed-response so the caller does NOT kick (the daemon
    // is up, just answered the wrong question).
    return {
      kind: "permanent",
      cause: "malformed_response",
      message: "stats response to render/click",
    };
  }
  switch (resp.code) {
    case "VERSION_MISMATCH":
      return {
        kind: "permanent",
        cause: "version_mismatch",
        clientV: PROTOCOL_VERSION,
        // Older daemons may not echo daemonV; fall back to "unknown
        // newer/older" by reporting 0. The renderer (chunk 2) shows a
        // useful message either way.
        daemonV: resp.daemonV ?? 0,
      };
    case "TIMEOUT":
      // Daemon is alive but didn't answer in time — same recovery as
      // unreachable: kick and emit stale/blank. This is the *only* non-ok
      // wire code that maps to transient.
      return {
        kind: "transient",
        cause: "timeout",
        message: resp.error,
      };
    case "BAD_REQUEST":
      return {
        kind: "permanent",
        cause: "bad_request",
        message: resp.error,
      };
    case "RENDER_FAILED":
      return {
        kind: "permanent",
        cause: "render_failed",
        message: resp.error,
      };
  }
}

// [LAW:no-defensive-null-guards] Exceptions here come from the connect/IO
// boundary — they are *trust-boundary* signals, not domain errors. Each
// known exception kind maps to a transient cause; unknown exceptions
// default to io_error.
function interpretException(e: unknown): TransientOutcome {
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
