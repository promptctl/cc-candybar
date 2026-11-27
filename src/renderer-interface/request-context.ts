// The session context a render request carries once it crossed the host's
// checkpoint: the vocabulary both sides of the renderer interface read
// (src/renderer-interface/interface.ts). It imports only types, so neither side runs the
// other's code through it.

import type { RenderOrigin, RequestedOrigin } from "../config-hint";
import type {
  ClientHints,
  ReaderRenderRequest,
  RefusedArg,
} from "../daemon/foundations/protocol";
import type { RenderEncoding } from "../render/encodings";
import type { ClientDeadline } from "../daemon/foundations/request-deadline";
import type { RateLimitsSeen } from "../daemon/foundations/sightings";
import type { SessionId } from "../daemon/foundations/session-id";
import type { ClaudeHookData } from "../utils/claude";
import type { Judged } from "../daemon/foundations/judge-run.js";

// A render request that crossed the checkpoint: its hookData carries every
// required field with its declared type and its cwd and workspace directories
// are absolute. `hints` contains the parsed client hints. Its args are parsed
// into `requested` — the config
// inputs it named, its explicit path the `--config` flag over the client's
// `CC_CANDYBAR_CONFIG` hint — and `refusedArgs`, `rateLimits` is
// what its hookData says of the rate-limit windows, and `deadline` is when its
// client hangs up. Raw `req.*` hint fields and `req.args` are not read past
// the checkpoint. `encoding` is how its answer is spelled. Only
// checkRenderRequest makes one.
// [LAW:one-source-of-truth] The hook's session id is the one the checkpoint
// parsed, so the session a template reads is the session every store keys by.
export type CheckedHookData = Omit<ClaudeHookData, "session_id"> & {
  readonly session_id: SessionId;
};

declare const CHECKED: unique symbol;
export type CheckedRenderRequest = Omit<
  ReaderRenderRequest,
  "deadline" | "encoding" | "hookData" | "env" | "envKey"
> & {
  readonly hookData: CheckedHookData;
  readonly sourceConfigDir?: string;
  readonly deadline: ClientDeadline;
  readonly encoding: RenderEncoding;
  readonly hints: ClientHints;
  readonly rateLimits: RateLimitsSeen;
  readonly requested: RequestedOrigin;
  readonly refusedArgs: readonly RefusedArg[];
  readonly [CHECKED]: true;
};

// [LAW:types-are-the-program] What a session is, as its newest request named
// it, apart from what its client reports now: the config inputs it renders
// from, and Claude Code's directory. Nothing in it moves with a terminal or a
// pane, so the host keeps it across a restart.
export interface DurableContext {
  readonly origin: RenderOrigin;
  readonly claudeConfigDir?: string;
}

// [LAW:types-are-the-program] A session as the host's book holds it: what it
// is, and its newest request heard since the daemon started, whose hints name
// its pane and terminal now. One read back after a restart has no live part
// until the session's next request, so nothing acts in a pane tmux may have
// handed another since.
export interface SessionContext {
  readonly session: SessionId;
  readonly durable: DurableContext;
  readonly live: CheckedRenderRequest | null;
}

// [LAW:one-source-of-truth] The one derivation of what a request says a
// session is, which both sides make of the requests they hear.
export function durableOf(req: CheckedRenderRequest): DurableContext {
  const { claudeConfigDir } = req.hints;
  return {
    origin: req.requested,
    ...(claudeConfigDir !== undefined && { claudeConfigDir }),
  };
}

// A session as a request heard now names it, live.
export function heardContextOf(req: CheckedRenderRequest): SessionContext {
  return {
    session: req.hookData.session_id,
    durable: durableOf(req),
    live: req,
  };
}

// What a session's declaration reads of its newest request: the keys every
// keyed lane is read at, the session among them.
export interface ViewFacts {
  readonly hookData: CheckedHookData;
  readonly cwd: string | undefined;
  // [LAW:locality-or-seam] The parsed client hints, NOT the raw request — this
  // module is downstream of the wire checkpoint and never re-sanitizes.
  readonly hints: ClientHints;
}

// The plugin sources a config declares, by variable name, at the storage
// folder the loader resolved for each: the real path.
export type DeclaredSources = ReadonlyMap<string, string>;

// What a session's renderer subscribes to: its config's plugin sources, and
// the runs its `shell` and `file` sources name, by digest, as the host judged
// each one, and its environment variables.
export interface Subscribed {
  readonly plugins: DeclaredSources;
  readonly runs: ReadonlyMap<string, Judged>;
  // The variables its `env` sources name, sorted.
  readonly env: readonly string[];
}
