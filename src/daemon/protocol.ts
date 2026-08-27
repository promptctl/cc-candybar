import type { Socket } from "node:net";
import type { ClaudeHookData } from "../utils/claude";
import type { StatsSnapshot } from "./stats";
import type { DebugSnapshot, DebugWhat } from "./debug-types";

// [LAW:types-are-the-program] PROTOCOL_VERSION encodes one thing:
// "old-client × new-daemon (or vice versa) cannot communicate." It moves on
// BREAKING changes only — never on additive ones. The two cases are
// genuinely different theorems and the version field carries the stronger:
// incompatibility, not growth.
//
// **Additive** (no bump):
//   - Adding a new request `kind`. Old daemons reject the unknown kind via
//     the existing BAD_REQUEST fallthrough; old clients never send it.
//   - Adding a new optional field that older parsers ignore safely.
//   - Adding a new response variant produced only in response to a new kind.
//
// **Breaking** (bump):
//   - Changing the semantics or required shape of an existing kind.
//   - Removing a kind or field old clients depend on.
//   - Renaming a wire field.
//
// The 452-corpse precedent (kz8.5) makes this discipline load-bearing: every
// bump forces every running statusbar through VERSION_MISMATCH until its
// session restarts, because the spiral-breaker contract refuses to kick on a
// permanent error. A bump for an additive change taxes every user with
// blank-statusbar minutes for a feature their session doesn't even use.
// Don't bump for growth.
export const PROTOCOL_VERSION = 3;

export interface RenderRequest {
  v: number;
  kind: "render";
  hookData: ClaudeHookData;
  args: string[];
  cwd: string;
  // ─── Client hints ────────────────────────────────────────────────────────
  // [LAW:single-enforcer] Facts only the LIVE CLIENT can observe, captured at
  // the trust boundary and trusted by the daemon. The daemon is detached and
  // one-per-user, so its own env answers for whichever shell spawned it —
  // possibly a different session, possibly hours ago. Every field below is
  // typed here but arrives as untrusted JSON: callers MUST route the request
  // through parseClientHints at the receive boundary, never read these
  // directly. See the ClientHints doc block for the absence semantics.
  termCols?: number;
  ssh?: boolean;
}

// [LAW:locality-or-seam] The seam for "a fact the daemon cannot observe about
// the session it is rendering for". `termCols` established the pattern; `ssh`
// is the second member, and the documented-but-unbuilt client-aware
// `colorCompatibility: "auto"` is the next. Naming the set as ONE type is what
// keeps that third addition a field rather than another sanitizer, another
// wire read, and another parameter threaded through the render path.
//
// [LAW:parse-dont-validate] This is the stamped type. `RenderRequest`'s
// same-named fields are raw JSON of unknown provenance; a `ClientHints` has
// crossed the checkpoint, so nothing downstream re-checks them.
//
// [LAW:types-are-the-program] Both fields are optional, but they mean
// DIFFERENT things by absence, and each is the strongest true theorem for its
// own fact:
//   • `termCols` absent — the client tried and could not determine a width
//     (no COLUMNS, no TTY on stderr). A genuine "unknown", reachable from any
//     client version.
//   • `ssh` absent — the client did not REPORT. A current client always knows
//     (its own env is total on this question) and so always sends `true` or
//     `false`; absence therefore means one thing only: a client too old to
//     carry the field — a real case, because `cc-candybar install` stages a
//     native binary that does not turn over with the npm package. Collapsing
//     that to `false` here would fuse "we know it's local" with "we don't
//     know" ([LAW:no-silent-failure]); instead it travels onward as an absent
//     payload field, where the DSL input-fallback chain emits the declared
//     default AND records a `last_error` that `cc-candybar debug vars`
//     surfaces.
export interface ClientHints {
  readonly termCols?: number;
  readonly ssh?: boolean;
}

// [LAW:single-enforcer] The ONE checkpoint where wire-supplied client hints
// become trusted values. Per-field sanitizers stay separate (each fact has its
// own validity rule) but nothing outside this function calls them, so a new
// hint cannot reach the render path un-sanitized.
export function parseClientHints(req: RenderRequest): ClientHints {
  const termCols = sanitizeTermCols(req.termCols);
  const ssh = sanitizeSsh(req.ssh);
  return {
    ...(termCols !== undefined && { termCols }),
    ...(ssh !== undefined && { ssh }),
  };
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

// [LAW:no-defensive-null-guards] exception: trust boundary, same shape as
// sanitizeTermCols. A non-boolean (absent, or a malformed/hostile frame) is
// NOT coerced to `false` — the three wire states stay three
// ([LAW:no-silent-failure]): true, false, and "no answer from this client".
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

// [LAW:types-are-the-program] The `what` discriminator carries the response
// shape forward — a client requesting "vars" gets vars data, "segments" gets
// segments data, "config" gets config data. No string-keyed lookup on the
// client side; route by structure. See DebugSnapshot in ./debug-types.
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
  // [LAW:types-are-the-program] DebugSnapshot is itself a discriminated union
  // on `what`, so the response type carries the requested kind through to the
  // client. A `{ ok: true; debug: { what: "vars"; vars: [...] } }` shape is
  // self-describing — the client doesn't need to remember which `what` it sent.
  | { ok: true; debug: DebugSnapshot }
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
// Callers in src/daemon/client-transport.ts branch on `e instanceof ProtocolError`
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
//
// [LAW:one-source-of-truth] FRAME_HEADER_BYTES and MAX_FRAME_BYTES are part
// of the wire contract the Rust client mirrors (rust-client/src/main.rs);
// scripts/check-protocol.mjs diffs them, so they must stay named consts.
export const FRAME_HEADER_BYTES = 4;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
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
    while (buf.length >= FRAME_HEADER_BYTES) {
      const len = buf.readUInt32BE(0);
      // Hard cap to defend against a runaway sender allocating gigabytes.
      // [LAW:types-are-the-program] ProtocolError carries the discriminator
      // structurally — interpretException routes on `instanceof`, not on a
      // brittle string match against the message body.
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
