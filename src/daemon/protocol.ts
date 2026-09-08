import type { Socket } from "node:net";
import type { ClaudeHookData } from "../utils/claude";
import type { StatsSnapshot } from "./stats";
import type { DebugSnapshot, DebugWhat } from "./debug-types";
import type { TmuxHint } from "../tmux-hint";
import { expandHome } from "../config/dsl-loader";

// [LAW:types-are-the-program] Bump on BREAKING wire changes only: a bump forces
// every running statusbar through VERSION_MISMATCH until its session restarts.
export const PROTOCOL_VERSION = 3;

export interface RenderRequest {
  v: number;
  kind: "render";
  hookData: ClaudeHookData;
  args: string[];
  cwd: string;
  // [LAW:single-enforcer] Untrusted JSON — route through parseClientHints at
  // the receive boundary, never read these directly.
  termCols?: number;
  termRows?: number;
  ssh?: boolean;
  tmux?: TmuxHint | null;
  configEnv?: string;
}

// [LAW:locality-or-seam] The seam for facts the daemon cannot observe about the
// session it renders for; ONE type keeps each addition a field, not another
// sanitizer and wire read. [LAW:parse-dont-validate] Stamped: nothing
// downstream re-checks. [LAW:types-are-the-program] Absence differs per field —
// an extent the client could not determine, versus `ssh`/`tmux`/`configEnv`
// unreported, never collapsed to `false` / "not in tmux" / "no override".
export interface ClientHints {
  readonly termCols?: number;
  readonly termRows?: number;
  readonly ssh?: boolean;
  readonly tmux?: TmuxHint | null;
  readonly configEnv?: string;
}

// [LAW:single-enforcer] The ONE checkpoint where wire hints become trusted, so
// a new hint cannot reach the render path un-sanitized. Typed over `unknown`,
// so a hint the daemon recorded itself crosses the same stamp.
export function parseClientHints(
  req: Partial<Record<keyof ClientHints, unknown>>,
): ClientHints {
  const termCols = sanitizeTermExtent(req.termCols);
  const termRows = sanitizeTermExtent(req.termRows);
  const ssh = sanitizeSsh(req.ssh);
  const tmux = sanitizeTmux(req.tmux);
  const configEnv = sanitizeConfigPath(req.configEnv);
  return {
    ...(termCols !== undefined && { termCols }),
    ...(termRows !== undefined && { termRows }),
    ...(ssh !== undefined && { ssh }),
    ...(tmux !== undefined && { tmux }),
    ...(configEnv !== undefined && { configEnv }),
  };
}

// [LAW:single-enforcer] The one rule for a client-supplied config path,
// whichever spelling carried it: empty is "no override", `~` is expanded.
export function sanitizeConfigPath(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? expandHome(v) : undefined;
}

// [LAW:no-defensive-null-guards] exception: trust boundary. `null` is the
// client's affirmative "not in tmux"; a malformed object is unreported.
export function sanitizeTmux(v: unknown): TmuxHint | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const { socket, pane, truecolor } = o;
  if (typeof socket !== "string" || socket === "") return undefined;
  if (typeof pane !== "string" || pane === "") return undefined;
  if (truecolor !== null && (typeof truecolor !== "string" || truecolor === ""))
    return undefined;
  return { socket, pane, truecolor };
}

// [LAW:no-defensive-null-guards] exception: trust boundary.
// [LAW:one-type-per-behavior] Columns and rows are one fact on two axes.
const MAX_TERM_EXTENT = 10000;
export function sanitizeTermExtent(v: unknown): number | undefined {
  if (typeof v !== "number") return undefined;
  if (!Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  if (n <= 0) return undefined;
  return n > MAX_TERM_EXTENT ? MAX_TERM_EXTENT : n;
}

// [LAW:no-defensive-null-guards] exception: trust boundary. A non-boolean is
// NOT coerced to `false` — the three wire states stay three.
export function sanitizeSsh(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
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

export interface DebugRequest {
  v: number;
  kind: "debug";
  what: DebugWhat;
}

export type Request =
  | RenderRequest
  | ShutdownRequest
  | StatsRequest
  | ClickRequest
  | DebugRequest;

export type Response =
  | { ok: true; output: string }
  | { ok: true; stats: StatsSnapshot }
  | { ok: true; debug: DebugSnapshot }
  // [LAW:types-are-the-program] `daemonV` echoes the daemon's own PROTOCOL_VERSION.
  | { ok: false; error: string; code: ErrorCode; daemonV?: number };

// [LAW:types-are-the-program] Two recovery classes: TIMEOUT is transient, every
// other code permanent — the client must NOT kick on the permanent ones.
export type ErrorCode =
  | "VERSION_MISMATCH"
  | "TIMEOUT"
  | "RENDER_FAILED"
  | "BAD_REQUEST";

// [LAW:types-are-the-program] Makes the kick-vs-show-error decision structural
// (`instanceof`) instead of a substring match on Node's wording.
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

// 4-byte big-endian length prefix + UTF-8 JSON body; error messages may embed
// newlines. [LAW:one-source-of-truth] Mirrored by the Rust client and diffed by
// scripts/check-protocol.mjs — keep them named consts.
export const FRAME_HEADER_BYTES = 4;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function makeFrameReader(
  onFrame: (frame: unknown) => void,
  onError: (err: Error) => void,
) {
  let buf = Buffer.alloc(0);
  return function feed(chunk: Buffer): void {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= FRAME_HEADER_BYTES) {
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        onError(new ProtocolError(`frame too large: ${len}`));
        return;
      }
      if (buf.length < FRAME_HEADER_BYTES + len) return;
      const body = buf.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + len);
      buf = buf.subarray(FRAME_HEADER_BYTES + len);
      try {
        onFrame(JSON.parse(body.toString("utf8")));
      } catch (e) {
        // Wrap SyntaxError so the recovery class is structurally typed.
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
