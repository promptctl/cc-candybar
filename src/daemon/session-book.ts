// [LAW:single-enforcer] The host's book of what each session is: its durable
// context (src/renderer-interface/request-context.ts), from its newest
// request, kept in the host's state directory, so a click after a restart,
// before the session's next request, still has the config it acts on. What
// its client reports now (pane, terminal) is the newest request's, held in
// memory by the frame feeds, and never kept here. The session's environment
// is held here in memory alone, never written: it carries keys and tokens,
// and a click finds it here after the collector has retired the session.

import { isAbsolute } from "node:path";
import {
  durableOf,
  heardContextOf,
  type CheckedRenderRequest,
  type DurableContext,
  type SessionContext,
} from "../renderer-interface/request-context.js";
import type { SessionId } from "./foundations/session-id.js";
import {
  NOT_HEARD,
  type SessionEnvironment,
} from "./foundations/session-env.js";
import { originOfRecord, originRecord } from "./foundations/render-origin.js";
import type {
  SessionFileKind,
  SessionFileStorage,
} from "./session-state-file.js";

// [LAW:carrying-cost] As many sessions as the host holds requests of.
const MAX_SESSIONS = 256;

export const SESSION_BOOK_FILE: SessionFileKind<DurableContext> = {
  name: "session-book",
  // Flat: the origin's record, and the Claude Code directory beside it.
  record: ({ origin, claudeConfigDir }) => ({
    ...originRecord(origin),
    ...(claudeConfigDir !== undefined && { claudeConfigDir }),
  }),
  // [LAW:parse-dont-validate] Every path a click acts on is absolute, as the
  // request it came from was.
  parse: (value) => {
    const origin = originOfRecord(value);
    if (origin === null)
      return { ok: false, problem: "is not the origin of a render" };
    const { claudeConfigDir } = value as { claudeConfigDir?: unknown };
    if (
      !isAbsolute(origin.projectDir) ||
      !isAbsolute(origin.cwd) ||
      (origin.target.path !== undefined && !isAbsolute(origin.target.path)) ||
      (claudeConfigDir !== undefined &&
        (typeof claudeConfigDir !== "string" || !isAbsolute(claudeConfigDir)))
    )
      return { ok: false, problem: "holds a path that is not absolute" };
    return {
      ok: true,
      value: {
        origin,
        ...(claudeConfigDir !== undefined && { claudeConfigDir }),
      },
    };
  },
};

// [LAW:one-source-of-truth] Whether two contexts keep as one record: every
// field the record holds, compared where it lies, since this runs on every
// request.
const sameDurable = (a: DurableContext, b: DurableContext): boolean =>
  a.origin.projectDir === b.origin.projectDir &&
  a.origin.cwd === b.origin.cwd &&
  a.origin.target.path === b.origin.target.path &&
  a.origin.target.source === b.origin.target.source &&
  a.claudeConfigDir === b.claudeConfigDir;

export class SessionBook {
  // [LAW:types-are-the-program] Insertion order is the order each session
  // was last heard in, which the bound drops the oldest of.
  private book = new Map<SessionId, DurableContext>();
  // The environment of each session heard since the daemon started.
  private readonly environments = new Map<SessionId, SessionEnvironment>();
  // [LAW:no-ambient-temporal-coupling] The file is saved to only while open,
  // and the close flushes what the open phase saved: before the load, a save
  // would land over the book the daemon before it flushed, unread; after the
  // close, over the file a next daemon has taken up. What is heard outside
  // it stays in memory.
  private phase: "unread" | "open" | "closed" = "unread";

  constructor(private readonly storage: SessionFileStorage<DurableContext>) {}

  // Read once the daemon serves. A session heard before it is newer than
  // anything the file holds of it, so it stays, and the file's come first.
  load(): void {
    const heard = this.book;
    this.book = new Map(
      [...this.storage.load()].filter(([session]) => !heard.has(session)),
    );
    for (const [session, durable] of heard) this.book.set(session, durable);
    this.bound();
    this.phase = "open";
    this.storage.save(new Map(this.book));
  }

  // The session's newest request: what it says the session is, saved when
  // it moved.
  heard(req: CheckedRenderRequest, environment: SessionEnvironment): void {
    const session = req.hookData.session_id;
    this.environments.set(session, environment);
    const durable = durableOf(req);
    const held = this.book.get(session);
    this.book.delete(session);
    this.book.set(session, durable);
    this.bound();
    if (held !== undefined && sameDurable(held, durable)) return;
    if (this.phase === "open") this.storage.save(new Map(this.book));
  }

  // [LAW:one-source-of-truth] The session as a click finds it: live from the
  // request heard since the daemon started, else what the book kept of it,
  // with no live part until its next request. Null for a session of neither.
  contextOf(
    session: SessionId,
    live: CheckedRenderRequest | null,
  ): SessionContext | null {
    if (live !== null) return heardContextOf(live);
    const durable = this.book.get(session);
    return durable === undefined ? null : { session, durable, live: null };
  }

  // [LAW:one-source-of-truth] The environment a program the host runs for
  // the session starts from: its newest request's, or why the host has none.
  environmentOf(session: SessionId): SessionEnvironment {
    return this.environments.get(session) ?? NOT_HEARD;
  }

  close(): Promise<void> {
    this.phase = "closed";
    return this.storage.flush();
  }

  private bound(): void {
    for (const oldest of this.book.keys()) {
      if (this.book.size <= MAX_SESSIONS) break;
      this.book.delete(oldest);
      this.environments.delete(oldest);
    }
  }
}
