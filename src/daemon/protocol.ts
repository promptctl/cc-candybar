import type { Socket } from "node:net";
import type { ClaudeHookData } from "../utils/claude";
import type { StatsSnapshot } from "./stats";

// Bumped on any wire-format change. Clients send their version; daemon refuses
// mismatches and shuts down so the next client respawns from current binary.
export const PROTOCOL_VERSION = 3;

export interface RenderRequest {
  v: number;
  kind: "render";
  hookData: ClaudeHookData;
  args: string[];
  cwd: string;
  // [LAW:single-enforcer] Terminal width is captured at the trust boundary
  // (the client's env, where COLUMNS/ioctl are meaningful) and trusted by the
  // daemon. Absence means the client couldn't determine it. The wire field is
  // typed `number` but the wire is untrusted JSON — callers MUST run it
  // through sanitizeTermCols at the receive boundary before using it.
  termCols?: number;
}

// [LAW:no-defensive-null-guards] exception: trust boundary. The wire is
// untrusted JSON; downstream code treats termCols as an integer in a sane
// range. Validate once here so the type's promise is true.
//
// Pathologically large values are capped (not rejected) so a future
// genuinely-huge terminal still renders — 10000 is two orders of magnitude
// above the largest plausible real terminal.
const MAX_TERM_COLS = 10000;
export function sanitizeTermCols(v: unknown): number | undefined {
  if (typeof v !== "number") return undefined;
  if (!Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  if (n <= 0) return undefined;
  return n > MAX_TERM_COLS ? MAX_TERM_COLS : n;
}

export interface ShutdownRequest {
  v: number;
  kind: "shutdown";
}

export interface ClickRequest {
  v: number;
  kind: "click";
  verb: string;
  value: string;
}

export interface StatsRequest {
  v: number;
  kind: "stats";
}

export type Request =
  | RenderRequest
  | ShutdownRequest
  | StatsRequest
  | ClickRequest;

export type Response =
  | { ok: true; output: string }
  | { ok: true; stats: StatsSnapshot }
  // [LAW:types-are-the-program] `daemonV` is the daemon's own
  // PROTOCOL_VERSION, echoed on every error response so the client can render
  // a meaningful diagnostic on VERSION_MISMATCH without parsing the human
  // message. Optional for back-compat: older daemons (or test stubs) that
  // omit it are still parseable by current clients.
  | { ok: false; error: string; code: ErrorCode; daemonV?: number };

// [LAW:types-are-the-program] The wire-level discriminator splits failures
// into two recovery classes: TIMEOUT is transient — the daemon is alive but
// slow, so a respawn or retry has a real chance of recovering. Every other
// code is permanent — respawning would hit the same response identically
// (the daemon refuses the request for VERSION_MISMATCH or BAD_REQUEST, or
// fails internally for RENDER_FAILED in a way the spawn loop cannot cure),
// so the spiral-breaker contract requires the client NOT to kick. The
// kick-vs-no-kick decision is encoded off this code, not off the error
// string.
export type ErrorCode =
  | "VERSION_MISMATCH"
  | "TIMEOUT"
  | "RENDER_FAILED"
  | "BAD_REQUEST";

// [LAW:types-are-the-program] A typed error class for failures that originate
// inside the wire-protocol layer (oversized frame, JSON decode failure).
// Callers in src/daemon/client.ts can branch on `e instanceof ProtocolError`
// to classify these as `permanent/malformed_response` — far more robust than
// substring-matching against the message, which would silently drift if
// Node's JSON.parse error wording changes. The class is small but
// load-bearing: it makes the kick-vs-show-error decision a structural
// property of the thrown value, not a property of its english string.
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

// 4-byte big-endian length prefix + UTF-8 JSON body. Length-prefix beats
// newline-delimited because error messages may contain embedded newlines and
// we'd rather not parse them out of-band.
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

// Streaming frame reader. Calls `onFrame` for each complete frame. Caller
// owns lifecycle — call `feed` with each chunk; reader keeps a buffer.
export function makeFrameReader(
  onFrame: (frame: unknown) => void,
  onError: (err: Error) => void,
) {
  let buf = Buffer.alloc(0);
  return function feed(chunk: Buffer): void {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      // Hard cap to defend against a runaway sender allocating gigabytes.
      // [LAW:types-are-the-program] ProtocolError carries the discriminator
      // structurally — interpretException routes on `instanceof`, not on a
      // brittle string match against the message body.
      if (len > 16 * 1024 * 1024) {
        onError(new ProtocolError(`frame too large: ${len}`));
        return;
      }
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      try {
        onFrame(JSON.parse(body.toString("utf8")));
      } catch (e) {
        // JSON.parse throws SyntaxError; wrap as ProtocolError so the
        // recovery class is structurally typed (not message-matched).
        // Preserve the original cause for diagnostic logging.
        const wrapped = new ProtocolError(
          e instanceof Error ? e.message : String(e),
        );
        if (e instanceof Error) {
          wrapped.cause = e;
        }
        onError(wrapped);
        return;
      }
    }
  };
}

// Send one frame and await one response, with a hard total budget. Resolves
// to the parsed response or rejects on timeout / parse error / socket error.
export function sendOne(
  sock: Socket,
  req: Request,
  totalBudgetMs: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners();
      try {
        fn();
      } catch {}
    };
    const timer = setTimeout(() => {
      finish(() => {
        sock.destroy();
        reject(new Error("TIMEOUT"));
      });
    }, totalBudgetMs);

    const reader = makeFrameReader(
      (frame) => finish(() => resolve(frame as Response)),
      (err) => finish(() => reject(err)),
    );
    sock.on("data", reader);
    sock.on("error", (err) => finish(() => reject(err)));
    sock.on("close", () =>
      finish(() => reject(new Error("socket closed before response"))),
    );

    sock.write(encodeFrame(req));
  });
}
