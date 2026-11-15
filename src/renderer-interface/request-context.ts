// The session context a render request carries once it crossed the host's
// checkpoint: the vocabulary both sides of the renderer interface read
// (src/renderer-interface/interface.ts). It imports only types, so neither side runs the
// other's code through it.

import type { RequestedOrigin } from "../config-hint";
import type {
  ClientHints,
  ReaderRenderRequest,
  RefusedArg,
  RenderEncoding,
} from "../daemon/foundations/protocol";
import type { ClientDeadline } from "../daemon/foundations/request-deadline";
import type { RateLimitsSeen } from "../daemon/foundations/sightings";
import type { SessionId } from "../daemon/foundations/session-id";
import type { ClaudeHookData } from "../utils/claude";
import type { RefreshLane } from "../facts/world-state.js";
import type { StorageKey } from "./interface.js";
import type { Judged } from "../daemon/foundations/judge-run.js";

// A render request that crossed the checkpoint: its hookData carries every
// required field with its declared type, its cwd is absolute, `hints` is its
// client hints, parsed, and its args are parsed into `requested` — the config
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
  "deadline" | "encoding" | "hookData"
> & {
  readonly hookData: CheckedHookData;
  readonly deadline: ClientDeadline;
  readonly encoding: RenderEncoding;
  readonly hints: ClientHints;
  readonly rateLimits: RateLimitsSeen;
  readonly requested: RequestedOrigin;
  readonly refusedArgs: readonly RefusedArg[];
  readonly [CHECKED]: true;
};

// The lanes a request's arrival refreshed: how long each took, in ms.
export type RefreshTimes = Readonly<Record<RefreshLane, number>>;

// What a session's declaration reads of its newest request: the keys every
// keyed lane is read at, the session among them.
export interface ViewFacts {
  readonly hookData: CheckedHookData;
  readonly cwd: string | undefined;
  // [LAW:locality-or-seam] The parsed client hints, NOT the raw request — this
  // module is downstream of the wire checkpoint and never re-sanitizes.
  readonly hints: ClientHints;
}

// The plugin sources a config declares, by variable name, at the storage key
// its render state's build took for each one's folder.
export type DeclaredSources = ReadonlyMap<string, StorageKey>;

// What a session's renderer subscribes to: its config's plugin sources, and
// the runs its `shell` and `file` sources name, by digest, as the host judged
// each one.
export interface Subscribed {
  readonly plugins: DeclaredSources;
  readonly runs: ReadonlyMap<string, Judged>;
}
