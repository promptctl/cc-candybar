// [LAW:single-enforcer] The host's book of what each session is: its durable
// context (src/renderer-interface/request-context.ts), from its newest
// request, kept in the host's state directory, so a click after a restart,
// before the session's next request, still has the config it acts on. What
// its client reports now (pane, terminal) comes from the newest request and
// its environment. The session's environment is held here in memory alone: it carries keys and tokens,
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
  type Environment,
  type RegisteredEnvironment,
  type SessionEnvironment,
} from "./foundations/session-env.js";
import { originOfRecord, originRecord } from "./foundations/render-origin.js";
import type {
  SessionFileKind,
  SessionFileStorage,
} from "./session-state-file.js";
import { kept, type StoreStanding } from "./foundations/stored-file.js";
import type { Asked } from "../utils/outcome.js";
import type { Timekeeper } from "../time.js";
import { HeldFile } from "./held-file.js";
import type { StoreReport } from "./foundations/stored-file.js";

// [LAW:carrying-cost] As many sessions as the host holds requests of.
const MAX_SESSIONS = 256;

export const SESSION_BOOK_FILE: SessionFileKind<DurableContext> = {
  name: "session-book",
  // Flat: the origin's record, and the Claude Code directory beside it.
  record: ({ origin, claudeConfigDir }) => ({
    ...originRecord(origin),
    ...(claudeConfigDir !== undefined && { claudeConfigDir }),
  }),
  parse: (value) => {
    const durable = durableOfRecord(value);
    return durable.kind === "ok" ? kept(durable.value) : durable;
  },
};

// [LAW:parse-dont-validate] Every path a click acts on is absolute, as the
// request it came from was.
function durableOfRecord(value: unknown): Asked<DurableContext> {
  const origin = originOfRecord(value);
  if (origin === null)
    return { kind: "failed", reason: "is not the origin of a render" };
  const { claudeConfigDir } = value as { claudeConfigDir?: unknown };
  if (
    !isAbsolute(origin.projectDir) ||
    !isAbsolute(origin.cwd) ||
    (origin.target.path !== undefined && !isAbsolute(origin.target.path)) ||
    (claudeConfigDir !== undefined &&
      (typeof claudeConfigDir !== "string" || !isAbsolute(claudeConfigDir)))
  )
    return { kind: "failed", reason: "holds a path that is not absolute" };
  return {
    kind: "ok",
    value: {
      origin,
      ...(claudeConfigDir !== undefined && { claudeConfigDir }),
    },
  };
}

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
  private readonly book: HeldFile<DurableContext>;
  // The environment of each session heard since the daemon started.
  private readonly environments = new Map<
    SessionId,
    SessionEnvironment | RegisteredEnvironment
  >();

  constructor(
    storage: SessionFileStorage<DurableContext>,
    clock: Pick<Timekeeper, "after">,
    told: (standing: StoreStanding) => void,
  ) {
    this.book = new HeldFile(
      "Session book",
      storage,
      clock,
      told,
      MAX_SESSIONS,
      sameDurable,
    );
  }

  // Read once the daemon serves. A session heard before it is newer than
  // anything the file holds of it, so it stays, and the file's come first.
  load(): StoreReport {
    const { report, evicted } = this.book.load();
    this.forget(evicted);
    return report;
  }

  // The session's newest request: what it says the session is, saved when
  // it moved, and otherwise only its place, which the file takes within the
  // order period.
  heard(
    req: CheckedRenderRequest,
    environment: SessionEnvironment | RegisteredEnvironment,
  ): void {
    const session = req.hookData.session_id;
    this.environments.set(session, environment);
    this.forget(
      this.book.take([{ kind: "put", key: session, value: durableOf(req) }]),
    );
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
    const held = this.environments.get(session) ?? NOT_HEARD;
    return "execution" in held ? { kind: "ok", value: held.execution } : held;
  }

  // A desktop tool or tmux command inherits the working directory and
  // environment of the same reported session. Only the directory is durable.
  programContextOf(
    session: SessionId,
  ): { readonly cwd: string; readonly environment: Environment } | null {
    const durable = this.book.get(session);
    const environment = this.environmentOf(session);
    return durable !== undefined && environment.kind === "ok"
      ? { cwd: durable.origin.cwd, environment: environment.value }
      : null;
  }

  reportedFor(session: SessionId, key: string): RegisteredEnvironment | null {
    const held = this.environments.get(session);
    return held && "key" in held && held.key === key ? held : null;
  }

  close(): Promise<void> {
    return this.book.close();
  }

  private forget(evicted: readonly SessionId[]): void {
    for (const session of evicted) this.environments.delete(session);
  }
}
