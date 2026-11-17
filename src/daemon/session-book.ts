// [LAW:single-enforcer] The host's book of what each session is: its durable
// context (src/renderer-interface/request-context.ts), from its newest
// request, kept in the host's state directory, so a click after a restart,
// before the session's next request, still has the config it acts on. What
// its client reports now (pane, terminal) is the newest request's, held in
// memory by the frame feeds, and never kept here.

import { isAbsolute } from "node:path";
import {
  durableOf,
  heardContextOf,
  type CheckedRenderRequest,
  type DurableContext,
  type SessionContext,
} from "../renderer-interface/request-context.js";
import type { SessionId } from "./foundations/session-id.js";
import { originOfRecord, originRecord } from "./foundations/render-origin.js";
import type { SessionFileKind } from "./session-state-file.js";

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
    if (origin === null) return null;
    const { claudeConfigDir } = value as { claudeConfigDir?: unknown };
    if (
      !isAbsolute(origin.projectDir) ||
      !isAbsolute(origin.cwd) ||
      (origin.target.path !== undefined && !isAbsolute(origin.target.path)) ||
      (claudeConfigDir !== undefined &&
        (typeof claudeConfigDir !== "string" || !isAbsolute(claudeConfigDir)))
    )
      return null;
    return {
      origin,
      ...(claudeConfigDir !== undefined && { claudeConfigDir }),
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

// Where the book is kept: its file, or nowhere.
export interface SessionBookStorage {
  load(): ReadonlyMap<SessionId, DurableContext>;
  save(snapshot: Readonly<Record<SessionId, DurableContext>>): void;
  flush(): void;
}

export const EPHEMERAL_SESSION_BOOK: SessionBookStorage = {
  load: () => new Map(),
  save: () => {},
  flush: () => {},
};

export class SessionBook {
  // [LAW:types-are-the-program] Insertion order is the order each session's
  // durable context last changed in, which the bound drops the oldest of.
  private book = new Map<SessionId, DurableContext>();
  private closed = false;

  constructor(private readonly storage: SessionBookStorage) {}

  // [LAW:no-ambient-temporal-coupling] Read once the daemon serves, after
  // the daemon before it flushed. A session heard before it is newer than
  // anything the file holds of it, so it stays, and the file's come first.
  load(): void {
    const heard = this.book;
    this.book = new Map(
      [...this.storage.load()].filter(([session]) => !heard.has(session)),
    );
    for (const [session, durable] of heard) this.book.set(session, durable);
    this.bound();
  }

  // The session's newest request: what it says the session is, kept when it
  // moved.
  heard(req: CheckedRenderRequest): void {
    const session = req.hookData.session_id;
    const durable = durableOf(req);
    const held = this.book.get(session);
    if (held !== undefined && sameDurable(held, durable)) return;
    this.book.delete(session);
    this.book.set(session, durable);
    this.bound();
    // [LAW:no-ambient-temporal-coupling] Once closed, what is heard stays in
    // memory, so it never lands over the file a next daemon has taken up.
    if (!this.closed) this.storage.save(Object.fromEntries(this.book));
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

  close(): void {
    this.storage.flush();
    this.closed = true;
  }

  private bound(): void {
    for (const oldest of this.book.keys()) {
      if (this.book.size <= MAX_SESSIONS) break;
      this.book.delete(oldest);
    }
  }
}
