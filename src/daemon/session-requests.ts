// [LAW:one-source-of-truth] The host's one book of each session's newest
// request, and the context it names (`SessionContext`): what a renderer's
// start opens each session at, what a click on the session and its status
// row read, and where the frame feeds find a session by its pane. The
// contexts outlive the daemon in a file, so a click after a daemon restart,
// before the session's next request, still finds its config and its pane.
// It is the host's own state, so it may name paths: no renderer stores one
// (docs/design/host-and-renderer.md I-10).

import path from "node:path";
import type { DaemonLogger } from "../utils/logger";
import type { ConfigTarget, RenderOrigin } from "../config-hint";
import { parseClientHints } from "./foundations/protocol";
import type { Answered } from "./foundations/sighting-roles";
import { sessionKeyed, type SessionId } from "./foundations/session-id";
import {
  contextOf,
  type CheckedRenderRequest,
  type SessionContext,
} from "../renderer-interface/request-context";
import type { StoreFile } from "./store-file";

// Generous headroom over realistic concurrent-session counts, as the render
// cache's bound: only a session long idle is ever forgotten.
const MAX_SESSIONS = 256;

// [LAW:types-are-the-program] What the book holds of a session: its context,
// and the request that named it with where it came in the order the daemon
// received requests, which makes one request later than another when their
// renders finish out of order. A context read back from the file has no
// request: none of it has come since the daemon started.
interface Held {
  readonly context: SessionContext;
  readonly request: {
    readonly req: CheckedRenderRequest;
    readonly order: number;
  } | null;
}

// What a context spells in the file: the context less its session, which
// keys it.
type Recorded = Omit<SessionContext, "session">;

export class SessionRequests {
  // [LAW:types-are-the-program] Insertion order is recency: the book holds
  // at most its bound, structurally.
  private readonly held = new Map<SessionId, Held>();
  private file: StoreFile | null;

  constructor(
    // The file the contexts are kept in, over what it is to hold.
    file: (body: () => string) => StoreFile,
    private readonly logger: DaemonLogger,
    // A session the bound never drops: one someone watches, whose
    // subscribers it is shown to.
    private readonly kept: (session: SessionId) => boolean,
  ) {
    this.file = file(() => this.text());
  }

  // [LAW:no-ambient-temporal-coupling] Read once this daemon has won the
  // socket: a daemon still in its close writes the file until it exits, so a
  // read made before then could hold contexts its flush then replaces. A
  // session noted already keeps what it was noted with.
  load(): void {
    if (this.file === null) return;
    for (const context of this.read(this.file))
      if (!this.held.has(context.session))
        this.held.set(context.session, { context, request: null });
    this.evictOldest();
  }

  // A request past the checkpoint, received `order`-th among requests of
  // every kind: its session's newest from now on, unless a later one came
  // first (a slow render finishing late). Saved only when its context moved,
  // so a session's every tick writes nothing.
  note(req: CheckedRenderRequest, order: number): boolean {
    const context = contextOf(req);
    const before = this.held.get(context.session);
    if (before?.request != null && before.request.order > order) return false;
    this.held.delete(context.session);
    this.held.set(context.session, { context, request: { req, order } });
    this.evictOldest();
    if (before === undefined || !sameContext(before.context, context))
      this.file?.save();
    return true;
  }

  // The newest request of `session` since the daemon started.
  latest(session: SessionId): CheckedRenderRequest | null {
    return this.held.get(session)?.request?.req ?? null;
  }

  // The context of `session` as its newest request named it, from before
  // the daemon started too.
  of(session: SessionId): SessionContext | null {
    return this.held.get(session)?.context ?? null;
  }

  // The session of the newest request `match` accepts, among the newest of
  // each session, or null when none does.
  newestWhere(match: (req: CheckedRenderRequest) => boolean): SessionId | null {
    let newest: { session: SessionId; order: number } | null = null;
    for (const [session, { request }] of this.held)
      if (
        request !== null &&
        match(request.req) &&
        (newest === null || request.order > newest.order)
      )
        newest = { session, order: request.order };
    return newest?.session ?? null;
  }

  // [LAW:no-ambient-temporal-coupling] The daemon's close: the owed write
  // lands, and anything noted later stays in memory, so it never lands over
  // the file a next daemon has taken up.
  close(): void {
    this.file?.flush();
    this.file = null;
  }

  // [LAW:single-enforcer] The bound, kept however the book grew: a note, or
  // a file written by a build with a larger one.
  private evictOldest(): void {
    for (const oldest of this.held.keys()) {
      if (this.held.size <= MAX_SESSIONS) break;
      if (!this.kept(oldest)) this.held.delete(oldest);
    }
  }

  private text(): string {
    // [LAW:types-are-the-program] A plain root: a session named `__proto__`
    // is a key like any other.
    const record = Object.create(null) as Record<string, Recorded>;
    for (const {
      context: { session, ...rest },
    } of this.held.values())
      record[session] = rest;
    return JSON.stringify(record);
  }

  // [LAW:no-silent-failure] A file that does not read, or an entry that does
  // not, is said and left out: that session's click waits for its next
  // request, as one never rendered does.
  private read(file: StoreFile): SessionContext[] {
    const text = file.read();
    if (text.kind === "failed") {
      this.logger("warn", `session contexts: ${text.reason}; starting empty`);
      return [];
    }
    if (text.value === null) return [];
    let doc: unknown;
    try {
      doc = JSON.parse(text.value);
    } catch (e) {
      this.logger(
        "warn",
        `session contexts: not JSON (${(e as Error).message}); starting empty`,
      );
      return [];
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      this.logger("warn", "session contexts: not an object; starting empty");
      return [];
    }
    const keyed = sessionKeyed(doc as Record<string, unknown>, (key, problem) =>
      this.logger(
        "warn",
        `session contexts: dropped ${JSON.stringify(key)}: session id ${problem}`,
      ),
    );
    const read: SessionContext[] = [];
    for (const [session, raw] of keyed) {
      const context = parseRecorded(session, raw);
      if (context === null)
        this.logger(
          "warn",
          `session contexts: dropped session ${session}: not a context`,
        );
      else read.push(context);
    }
    return read;
  }
}

function sameContext(a: SessionContext, b: SessionContext): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const isAbsolute = (v: unknown): v is string =>
  typeof v === "string" && path.isAbsolute(v);

// [LAW:parse-dont-validate] A recorded context, through the checks a request
// crosses: absolute directories, a target of a kind this build reads, and
// the hints through the one hint checkpoint.
function parseRecorded(
  session: SessionId,
  raw: unknown,
): SessionContext | null {
  if (raw === null || typeof raw !== "object") return null;
  const { requested, hints, transcript, answered } = raw as Record<
    string,
    unknown
  >;
  if (typeof transcript !== "string" || !isAnswered(answered)) return null;
  if (requested === null || typeof requested !== "object") return null;
  if (hints === null || typeof hints !== "object") return null;
  const { projectDir, cwd, target } = requested as Record<string, unknown>;
  const parsedTarget = parseTarget(target);
  if (!isAbsolute(projectDir) || !isAbsolute(cwd) || parsedTarget === null)
    return null;
  const origin: RenderOrigin = { projectDir, cwd, target: parsedTarget };
  const { client: _client, ...sessionHints } = parseClientHints(
    hints as Record<string, unknown>,
  );
  return {
    session,
    requested: origin,
    hints: sessionHints,
    transcript,
    answered,
  };
}

const isAnswered = (v: unknown): v is Answered =>
  v === "yes" || v === "no" || v === "unknown";

function parseTarget(raw: unknown): ConfigTarget | null {
  if (raw === null || typeof raw !== "object") return null;
  const { source, path: file } = raw as Record<string, unknown>;
  if (source === "search" && file === undefined) return { source };
  if ((source === "argument" || source === "environment") && isAbsolute(file))
    return { source, path: file };
  return null;
}
