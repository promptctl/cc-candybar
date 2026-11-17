// [LAW:one-source-of-truth] Each session's context as its newest request named
// it (`SessionContext`): what a click on the session and its lanes' setup
// read. The host keeps it across its own restarts, so a click after a daemon
// restart, before the session's next request, still finds its config and its
// pane. It is the host's own state, so it may name paths: no renderer stores
// one (docs/design/host-and-renderer.md I-10).

import path from "node:path";
import type { DaemonLogger } from "../utils/logger";
import type { Timekeeper } from "../time";
import type { ConfigTarget, RenderOrigin } from "../config-hint";
import { parseClientHints } from "./foundations/protocol";
import type { Answered } from "./foundations/sighting-roles";
import { sessionKeyed, type SessionId } from "./foundations/session-id";
import {
  contextOf,
  type CheckedRenderRequest,
  type SessionContext,
} from "../renderer-interface/request-context";
import { DebouncedStoreFile, type StoreFile } from "./store-file";

// Generous headroom over realistic concurrent-session counts, as the render
// cache's bound: only a session long idle is ever forgotten.
const MAX_SESSIONS = 256;

// What a context spells in the file: the context less its session, which
// keys it.
type Recorded = Omit<SessionContext, "session">;

export class SessionContexts {
  // [LAW:types-are-the-program] Insertion order is recency: the book holds
  // at most its bound, structurally.
  private readonly held = new Map<SessionId, SessionContext>();
  private file: StoreFile | null;

  constructor(
    filePath: string,
    clock: Pick<Timekeeper, "after" | "monotonic">,
    failed: (reason: string) => void,
    private readonly logger: DaemonLogger,
  ) {
    this.file = new DebouncedStoreFile(
      filePath,
      () => this.text(),
      clock,
      failed,
      logger,
    );
    this.load(this.file);
  }

  // A request past the checkpoint: its session's context from now on. Saved
  // only when it moved, so a session's every tick writes nothing.
  note(req: CheckedRenderRequest): void {
    const context = contextOf(req);
    const before = this.held.get(context.session);
    this.held.delete(context.session);
    this.held.set(context.session, context);
    if (before !== undefined && sameContext(before, context)) return;
    this.evictOldest();
    this.file?.save();
  }

  // [LAW:single-enforcer] The bound, kept however the book grew: a note, or
  // a file written by a build with a larger one.
  private evictOldest(): void {
    for (const oldest of this.held.keys()) {
      if (this.held.size <= MAX_SESSIONS) break;
      this.held.delete(oldest);
    }
  }

  of(session: SessionId): SessionContext | null {
    return this.held.get(session) ?? null;
  }

  // [LAW:no-ambient-temporal-coupling] The daemon's close: the owed write
  // lands, and anything noted later stays in memory.
  close(): void {
    this.file?.flush();
    this.file = null;
  }

  private text(): string {
    const record: Record<string, Recorded> = {};
    for (const { session, ...rest } of this.held.values())
      record[session] = rest;
    return JSON.stringify(record);
  }

  // [LAW:no-silent-failure] A file that does not read, or an entry that does
  // not, is said and left out: that session's click waits for its next
  // request, as one never rendered does.
  private load(file: StoreFile): void {
    const text = file.read();
    if (text.kind === "failed") {
      this.logger("warn", `session contexts: ${text.reason}; starting empty`);
      return;
    }
    if (text.value === null) return;
    let doc: unknown;
    try {
      doc = JSON.parse(text.value);
    } catch (e) {
      this.logger(
        "warn",
        `session contexts: not JSON (${(e as Error).message}); starting empty`,
      );
      return;
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      this.logger("warn", "session contexts: not an object; starting empty");
      return;
    }
    const keyed = sessionKeyed(doc as Record<string, unknown>, (key, problem) =>
      this.logger(
        "warn",
        `session contexts: dropped ${JSON.stringify(key)}: session id ${problem}`,
      ),
    );
    for (const [session, raw] of keyed) {
      const context = parseRecorded(session, raw);
      if (context === null)
        this.logger(
          "warn",
          `session contexts: dropped session ${session}: not a context`,
        );
      else this.held.set(session, context);
    }
    this.evictOldest();
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
