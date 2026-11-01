import path from "node:path";
import type { Duplex } from "node:stream";
import type { ClaudeHookData } from "../utils/claude";
import type { StatsSnapshot } from "./stats";
import type { DebugSnapshot, DebugWhat } from "./debug-types";
import type { TmuxHint } from "../tmux-hint";
import { TERMINAL_ENV_VARS, type TerminalEnvHint } from "../terminal-hint";
import { CLIENT_KINDS, type ClientHint, type ClientKind } from "../client-hint";
import type { Lane } from "../config/lanes";
import type { BandBar } from "../../mod/types";
import type { WireFrame } from "../render/frame";
import type { TmuxStatusBar } from "../tmux-status/frames";

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
//   - Adding a new response variant produced only in response to a new kind
//     or a new request field.
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

// [LAW:one-source-of-truth] A statusline client's budgets: how long its
// connect may take, and how long its render round trip has. Wire facts, read
// by the client that spends them and the daemon that answers inside them
// (src/daemon/request-deadline.ts). Mirrored by the Rust client
// (rust-client/src/main.rs) and diffed by scripts/check-protocol.mjs, which
// anchors on these declarations.
export const CONNECT_TIMEOUT_MS = 50;
export const TOTAL_BUDGET_MS = 150;

export interface RenderRequest {
  v: number;
  kind: "render";
  hookData: ClaudeHookData;
  // The client's own path, then the flags the statusline command gave it —
  // the native binary's, the Node script's, never the node interpreter's.
  // Anything after the path that is not `--config <file>` is refused as the
  // bar's error (parseRenderArgs, render-checkpoint.ts).
  args: string[];
  cwd: string;
  // When the client hangs up, in epoch milliseconds: the daemon's wait for
  // this request's refreshes ends early enough to draw before it
  // (src/daemon/request-deadline.ts). Absent from a client too old to state
  // one. Never a hint: it is new on every request, and the hints are recorded
  // per session whenever they change.
  deadline?: number;
  // ─── Client hints ────────────────────────────────────────────────────────
  // [LAW:single-enforcer] Facts only the LIVE CLIENT can observe, captured at
  // the trust boundary and trusted by the daemon. The daemon is detached and
  // one-per-user, so its own env answers for whichever shell spawned it —
  // possibly a different session, possibly hours ago. Every field below is
  // typed here but arrives as untrusted JSON: callers MUST route the request
  // through parseClientHints at the receive boundary, never read these
  // directly. See the ClientHints doc block for the absence semantics.
  termCols?: number;
  termRows?: number;
  ssh?: boolean;
  tmux?: TmuxHint | null;
  configEnv?: string;
  claudeConfigDir?: string;
  terminalEnv?: TerminalEnvHint;
  client?: ClientHint;
}

// [LAW:no-mode-explosion] How a render is answered: the bytes a terminal
// prints, or the Frame. The cap is these two, and the second has no exit, since
// a reader holding one render's answer has no other way to read the bar once
// decoding is ruled out. A new surface is a lane (LANES, LANE_FRAMES), which
// names its own encoding, so a subscription takes none.
export const RENDER_ENCODINGS = ["ansi", "frame"] as const;
export type RenderEncoding = (typeof RENDER_ENCODINGS)[number];

// [LAW:types-are-the-program] A render as a script or harness asks for it.
// `RenderRequest` stays what the shipped clients send, key for key, which
// scripts/check-protocol.mjs diffs against the native client, and they never
// send this: absent is `ansi`.
export interface ReaderRenderRequest extends RenderRequest {
  encoding?: RenderEncoding;
}

// [LAW:locality-or-seam] The seam for "a fact the daemon cannot observe about
// the session it is rendering for". `termCols` established the pattern; `ssh`
// and `termRows` (the terminal's height) followed it, and the
// documented-but-unbuilt client-aware `colorCompatibility: "auto"` is the
// next. Naming the set as ONE type is what keeps each addition a field
// rather than another sanitizer, another wire read, and another parameter
// threaded through the render path.
//
// [LAW:parse-dont-validate] This is the stamped type. `RenderRequest`'s
// same-named fields are raw JSON of unknown provenance; a `ClientHints` has
// crossed the checkpoint, so nothing downstream re-checks them.
//
// [LAW:types-are-the-program] Both fields are optional, but they mean
// DIFFERENT things by absence, and each is the strongest true theorem for its
// own fact:
//   • `termCols` / `termRows` absent — the client tried and could not
//     determine that extent (no COLUMNS/LINES, no TTY on stderr). A genuine
//     "unknown", reachable from any client version — and for `termRows` also
//     the old-client case, which reads the same way: no row cap from the
//     client, so the daemon's own ceiling applies.
//   • `ssh` absent — the client did not REPORT. A current client always knows
//     (its own env is total on this question) and so always sends `true` or
//     `false`; absence therefore means one thing only: a client too old to
//     carry the field — a real case, because `cc-candybar install` stages a
//     native binary that does not turn over with the npm package. Collapsing
//     that to `false` here would fuse "we know it's local" with "we don't
//     know" ([LAW:no-silent-failure]); instead it travels onward as an absent
//     payload field, where the DSL input-fallback chain emits the declared
//     default AND records a `last_error` that `cc-candybar vars`
//     surfaces.
//   • `tmux` has THREE states, and they are never collapsed: absent — the
//     client did not report (too old, same as `ssh`); `null` — the client
//     reported "not in tmux" (total, like `ssh: false`); an object — the tmux
//     facts the doctor's tmux-truecolor check reasons over (src/doctor). The
//     daemon records the parsed hints per session (SESSION_CLIENT_HINTS_KEY)
//     so a click, which carries no hints of its own, can read them.
//   • `configEnv` absent — the client's shell carries no `CC_CANDYBAR_CONFIG`
//     (or the client is too old to report one; both read the same way: no
//     override from the client, the precedence chain applies). Present, it is
//     the absolute path the client resolved the variable to against its own
//     cwd (detectConfigEnv, src/config-hint.ts); it ranks beneath a load-config
//     pick and `--config`, and is never read from the daemon's own env —
//     the override that ticket brandon-config-5g8 measured going nowhere.
//   • `claudeConfigDir` absent — the client's Claude Code runs with no
//     CLAUDE_CONFIG_DIR (or the client is too old to say; both mean the
//     default directory, what every reader assumed before the hint existed).
//     Present, it is the absolute directory the client resolved from it
//     (detectClaudeConfigDir, src/claude-settings.ts) — the one whose
//     settings.json that session's Claude Code reads.
//   • `client` absent — the client did not REPORT what it is: a client too
//     old to carry the field, which is itself the doctor's finding (an
//     install whose client predates its daemon). Present, it is total: the
//     client's kind, the bundle it runs, its build stamp (src/client-hint.ts).
export interface ClientHints {
  readonly termCols?: number;
  readonly termRows?: number;
  readonly ssh?: boolean;
  readonly tmux?: TmuxHint | null;
  readonly configEnv?: string;
  readonly claudeConfigDir?: string;
  readonly terminalEnv?: TerminalEnvHint;
  readonly client?: ClientHint;
}

// [LAW:one-source-of-truth] Every field of ClientHints, keyed by the type so
// a new hint is a compile error here until it is listed.
const CLIENT_HINT_FIELDS = Object.keys({
  termCols: true,
  termRows: true,
  ssh: true,
  tmux: true,
  configEnv: true,
  claudeConfigDir: true,
  terminalEnv: true,
  client: true,
} satisfies Record<keyof ClientHints, true>) as ReadonlyArray<
  keyof ClientHints
>;

// [LAW:single-enforcer] The ONE checkpoint where wire-supplied client hints
// become trusted values. Per-field sanitizers stay separate (each fact has its
// own validity rule) but every hint crosses HERE, so a new hint cannot reach
// the render path un-sanitized. The parameter is the hint
// field-set over `unknown` rather than `RenderRequest`, so the daemon can push a
// RECORDED hint (JSON it wrote itself, read back from SessionState) through the
// same checkpoint a live frame crosses — one stamp, two provenances.
export function parseClientHints(
  req: Partial<Record<keyof ClientHints, unknown>>,
): ClientHints {
  const termCols = sanitizeTermExtent(req.termCols);
  const termRows = sanitizeTermExtent(req.termRows);
  const ssh = sanitizeSsh(req.ssh);
  const tmux = sanitizeTmux(req.tmux);
  const configEnv = sanitizeAbsolutePath(req.configEnv);
  const claudeConfigDir = sanitizeAbsolutePath(req.claudeConfigDir);
  const terminalEnv = sanitizeTerminalEnv(req.terminalEnv);
  const client = sanitizeClient(req.client);
  return {
    ...(termCols !== undefined && { termCols }),
    ...(termRows !== undefined && { termRows }),
    ...(ssh !== undefined && { ssh }),
    ...(tmux !== undefined && { tmux }),
    ...(configEnv !== undefined && { configEnv }),
    ...(claudeConfigDir !== undefined && { claudeConfigDir }),
    ...(terminalEnv !== undefined && { terminalEnv }),
    ...(client !== undefined && { client }),
  };
}

// [LAW:no-silent-failure] A hint the client SENT that the checkpoint refused
// is not the same fact as one it never sent: the render goes on without it
// (one malformed field must not cost the bar), but the bar and the render
// event say so. The producer that reaches this is a client older than the
// daemon whose hint contract has since tightened (brandon-config-nuq6:
// `configEnv` was raw, now absolute), which would otherwise render a
// different config with no word why. Derived from the raw request and the
// stamped hints, so no sanitizer learns a third state.
export interface RefusedHint {
  readonly hint: keyof ClientHints;
  readonly sent: unknown;
}

export function refusedHints(
  req: Partial<Record<keyof ClientHints, unknown>>,
  hints: ClientHints,
): readonly RefusedHint[] {
  return CLIENT_HINT_FIELDS.filter(
    (k) => req[k] !== undefined && hints[k] === undefined,
  ).map((hint) => ({ hint, sent: req[hint] }));
}

// The error message for the refused hints, null when every sent hint was
// taken.
export function refusedHintsError(
  refused: readonly RefusedHint[],
): string | null {
  return refused.length === 0
    ? null
    : `Client hints refused: ${refused
        .map(({ hint, sent }) => `${hint}=${JSON.stringify(sent)}`)
        .join(
          ", ",
        )} — is the statusline client older than the daemon? Reinstall it (\`cc-candybar install\`, or \`just install-rust\` in a checkout).`;
}

// An argument in a render request's argv that the render does not act on: a
// flag it does not know, `--config` with no file after it
// (brandon-unfiled-3248.8bz: `parseArgs` without `strict` reads a bare
// `--config` as `true`, which was rendered as no override with no word why),
// or a positional word (only flags reach a render: a positional first word is
// a subcommand, which never gets here).
export interface RefusedArg {
  readonly arg: string;
  readonly why: "unknown" | "no-value" | "positional";
}

// [LAW:types-are-the-program] One line per kind of refusal, keyed by the
// union, so a new kind does not compile until it is said.
const REFUSAL_LINES: Readonly<
  Record<RefusedArg["why"], (args: string) => string>
> = {
  unknown: (args) => `Unknown flags: ${args}`,
  // Only the last `--config` can lack a file, and it wins, so an earlier one
  // that named a file is not applied either.
  "no-value": (arg) => `${arg} names no file — the bar renders with no ${arg}`,
  positional: (args) => `Unexpected arguments: ${args}`,
};

// The error message for the refused arguments, null when every argument
// was taken. Either way the bar renders without them.
export function refusedArgsError(
  refused: readonly RefusedArg[],
): string | null {
  const lines = (
    Object.keys(REFUSAL_LINES) as Array<RefusedArg["why"]>
  ).flatMap((why) => {
    const args = refused.filter((r) => r.why === why).map((r) => r.arg);
    return args.length === 0 ? [] : [REFUSAL_LINES[why](args.join(", "))];
  });
  return lines.length === 0 ? null : lines.join("\n");
}

// [LAW:no-defensive-null-guards] exception: trust boundary, same shape as
// sanitizeTmux. Only the variables of TERMINAL_ENV_VARS are read, each a
// non-empty string as both clients send it; one that is anything else makes
// the whole hint unreported (`undefined`).
export function sanitizeTerminalEnv(v: unknown): TerminalEnvHint | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const set = TERMINAL_ENV_VARS.filter((name) => o[name] !== undefined);
  return set.every((name) => typeof o[name] === "string" && o[name] !== "")
    ? Object.fromEntries(set.map((name) => [name, o[name] as string]))
    : undefined;
}

// [LAW:no-defensive-null-guards] exception: trust boundary. Both clients
// resolve the path against their own cwd before sending it, so anything
// but an absolute path is a frame no client of ours builds — "not reported"
// (`undefined`), never a path the daemon would resolve against ITS cwd.
function sanitizeAbsolutePath(v: unknown): string | undefined {
  return typeof v === "string" && path.isAbsolute(v) ? v : undefined;
}

// [LAW:no-defensive-null-guards] exception: trust boundary, same shape as
// sanitizeSsh. `null` is the client's affirmative "not in tmux" and passes
// through as `null`; an object must carry exactly the TmuxHint fields with
// their types, or the hint is treated as unreported (`undefined`) — a
// malformed frame never becomes a half-true set of tmux facts.
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

// [LAW:no-defensive-null-guards] exception: trust boundary. The wire is
// untrusted JSON; downstream code treats a terminal extent (cols or rows) as
// an integer in a sane range. Validate once here so the type's promise is
// true. [LAW:one-type-per-behavior] Columns and rows are the same fact about
// two axes — one sanitizer, two call sites.
//
// Pathologically large values are capped (not rejected) so a future
// genuinely-huge terminal still renders — 10000 is two orders of magnitude
// above the largest plausible real terminal on either axis.
const MAX_TERM_EXTENT = 10000;
export function sanitizeTermExtent(v: unknown): number | undefined {
  if (typeof v !== "number") return undefined;
  if (!Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  if (n <= 0) return undefined;
  return n > MAX_TERM_EXTENT ? MAX_TERM_EXTENT : n;
}

// [LAW:no-defensive-null-guards] exception: trust boundary, same shape as
// sanitizeTermExtent. A non-boolean (absent, or a malformed/hostile frame) is
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
  // The package version of the client that delivered the click — the URL
  // handler's staged runtime, or a page whose daemon runs in it. Absent from
  // a handler too old to report it.
  clientVersion?: string;
}

export function sanitizeClientVersion(v: unknown): string | null {
  return typeof v === "string" && v !== "" && v.length <= 64 ? v : null;
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

// [LAW:one-type-per-behavior] A subscription's stream is a stream of the
// responses a render request is answered with: every frame the daemon draws
// for the session whose bytes differ from the last one sent, until the
// subscriber closes the socket. The frames are drawn from the session's latest
// render request (src/daemon/frame-feed.ts), so a session subscribed to before
// its first render streams nothing until that render arrives. A subscription
// names the animation lane it serves (src/config/lanes.ts); the session's own
// settings decide whether that lane may have its frames.
export interface SubscribeRequest {
  v: number;
  kind: "subscribe";
  sessionId: string;
  lane: Lane;
}

// Which session last rendered from a tmux pane: the session of the daemon's
// newest render request whose client reported that pane. A tmux bar pane
// (lane C) knows the pane it draws beside, not the session in it, which
// changes on a /clear; it asks again to follow.
export interface PaneSessionRequest {
  v: number;
  kind: "pane-session";
  socket: string;
  pane: string;
}

export type Request =
  | ReaderRenderRequest
  | SubscribeRequest
  | PaneSessionRequest
  | ShutdownRequest
  | StatsRequest
  | ClickRequest
  | DebugRequest;

export type Response =
  | { ok: true; output: string }
  // A render asked for as `encoding: "frame"`, read through `parseFrame`.
  | { ok: true; frame: WireFrame }
  | { ok: true; stats: StatsSnapshot }
  // [LAW:types-are-the-program] DebugSnapshot is itself a discriminated union
  // on `what`, so the response type carries the requested kind through to the
  // client. A `{ ok: true; debug: { what: "vars"; vars: [...] } }` shape is
  // self-describing — the client doesn't need to remember which `what` it sent.
  | { ok: true; debug: DebugSnapshot }
  // A pane-session answer: the session, or null when no request the daemon
  // holds came from that pane.
  | { ok: true; paneSession: string | null }
  // A band-lane subscriber's frame: the bar as the band mod's rows of styled
  // runs (src/daemon/lane-frames.ts), declared by the mod (mod/types).
  | BandBar
  // A tmux-status-lane subscriber's frame: the bar as a tmux status line's
  // rows and the links of their ranges (src/tmux-status/frames.ts).
  | { ok: true; tmuxStatus: TmuxStatusBar }
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
// SWITCHED_OFF is a third class: the request is well formed and the daemon
// is healthy, but a setting the user controls refuses it — a subscription
// whose animation lane is off. The same request succeeds once the setting is
// turned on, so a client waits and asks again rather than kicking or giving up.
export type ErrorCode =
  | "VERSION_MISMATCH"
  | "TIMEOUT"
  | "RENDER_FAILED"
  | "BAD_REQUEST"
  | "SWITCHED_OFF";

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
  return encodeJsonFrame(JSON.stringify(value));
}

// A frame of JSON already serialized: a pushed frame is serialized once for
// every subscriber.
export function encodeJsonFrame(json: string): Buffer {
  const body = Buffer.from(json, "utf8");
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

// Send one frame and await one response, giving up at `deadline` (epoch
// milliseconds) — the instant a render request states as its own, so the
// client hangs up when it said it would. Resolves to the parsed response or
// rejects on timeout / parse error / socket error.
export function sendOne(
  sock: Duplex,
  req: Request,
  deadline: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // [LAW:locality-or-seam] Only its own: the stream's other listeners are
      // what carry its end and its hang-up, and they aren't this call's.
      sock.off("data", reader);
      sock.off("error", onError);
      sock.off("close", onClose);
      try {
        fn();
      } catch {}
    };
    const timer = setTimeout(() => {
      finish(() => {
        sock.destroy();
        reject(new Error("TIMEOUT"));
      });
    }, deadline - Date.now());

    const reader = makeFrameReader(
      (frame) => finish(() => resolve(frame as Response)),
      (err) => finish(() => reject(err)),
    );
    const onError = (err: Error): void => finish(() => reject(err));
    const onClose = (): void =>
      finish(() => reject(new Error("socket closed before response")));
    sock.on("data", reader);
    sock.on("error", onError);
    sock.on("close", onClose);

    sock.write(encodeFrame(req));
  });
}

// [LAW:no-defensive-null-guards] exception: trust boundary, the shape of
// sanitizeTerminalEnv. A hint whose fields are anything but a known kind, an
// absolute bundle path and a non-empty-or-null stamp is unreported
// (`undefined`) — refused whole, never half-trusted.
export function sanitizeClient(v: unknown): ClientHint | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const { kind, bundle, source } = v as Record<string, unknown>;
  const path = sanitizeAbsolutePath(bundle);
  return (CLIENT_KINDS as readonly unknown[]).includes(kind) &&
    path !== undefined &&
    (source === null || (typeof source === "string" && source !== ""))
    ? { kind: kind as ClientKind, bundle: path, source }
    : undefined;
}
