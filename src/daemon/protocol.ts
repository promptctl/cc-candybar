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
// Returns undefined for: non-number, NaN/Infinity, non-integer, ≤ 0, or
// >= MAX_TERM_COLS. Caps at MAX_TERM_COLS rather than rejecting so a future
// genuinely-huge terminal still renders (10000 is two orders of magnitude
// above the largest plausible real terminal).
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
  | { ok: false; error: string; code: ErrorCode };

export type ErrorCode =
  | "VERSION_MISMATCH"
  | "TIMEOUT"
  | "RENDER_FAILED"
  | "BAD_REQUEST";

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
      if (len > 16 * 1024 * 1024) {
        onError(new Error(`frame too large: ${len}`));
        return;
      }
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      try {
        onFrame(JSON.parse(body.toString("utf8")));
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
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
