// A session's recording: its stream written out of the running daemon, line
// by line, as a recording a renderer replays offline (src/facts/recording.ts,
// docs/design/gather-and-renderer.md §14) — the documents its view takes, the
// requests it is drawn by and the draws of their answers.
//
// [LAW:one-source-of-truth] A recording follows the session's current view as
// the render cache holds it, and keeps no record of views of its own: the
// cache says when the session's view changes, and the recording reads the
// view back from the cache. A view whose open failed is never entered, and a
// view the cache dropped is left in the same call, so one view writes at a
// time — the cache's current one. A successor's opening document starts its
// sequence again, which a replay shows at its instant as the live bar did.

import { inspect } from "node:util";
import { appendFileSync, closeSync, openSync, unlinkSync } from "node:fs";
import { reaction } from "mobx";
import {
  formatLine,
  type DrawState,
  type FactsLine,
  type RecordingLine,
  type RequestLine,
} from "../facts/recording.js";
import type { SessionFacts } from "../facts/session-facts.js";
import type { ViewFacts } from "./render-payload.js";
import type { Timekeeper } from "../time.js";
import type { Instant } from "../utils/instant.js";
import type { DaemonLogger } from "../utils/logger.js";
import type { RenderCacheObservers, SessionView } from "./cache/render.js";
import type { Settling } from "./facts-source.js";
import type { Recorded } from "./protocol.js";
import type { SessionId } from "./session-id.js";
import type { SessionSource } from "./session-source.js";

// What a recording reads of the cache: the session's current view, the
// documents its follow stamps and the home its payloads are composed against.
export interface RecordedView {
  readonly followed: SessionView["followed"];
  readonly source: Pick<SessionSource, "home">;
}

export interface SessionViews {
  sessionView(sessionId: string): RecordedView | null;
}

// How a recording ended: by its stop, by the daemon closing before the stop
// came, or by a write that threw.
export type RecordingEnd =
  | { readonly kind: "stopped" }
  | { readonly kind: "closed" }
  | { readonly kind: "failed"; readonly error: unknown };

// Where a recording's lines go, and what hears it end.
export interface RecordingSink {
  write(line: RecordingLine): void;
  end(how: RecordingEnd): void;
}

export interface SessionRecorder {
  // Starts recording the session into `sink`: the header, the current view's
  // document, then each document, request and draw as they come. Returns its
  // stop.
  // [LAW:no-silent-failure] A session the cache holds no view for is refused,
  // naming it: there is nothing of it here to record.
  record(session: SessionId, sink: RecordingSink): () => void;
  // The cache's say that the session's current view changed.
  moved(sessionId: string): void;
  // A request arrived at the session's view (`settleRequest`): the recordings
  // that noted it, which its answer's draw is written to.
  arrived(sessionId: string, line: RequestLine): Arrival;
  // The answer to `arrival` was drawn from `read` (`drawRequest`).
  drew(sessionId: string, arrival: Arrival, read: DrawnFrom): void;
  // Every open recording ends, and every later one is refused: the daemon
  // is closing.
  close(): void;
}

// A request as its recordings noted it: its instant, and the recordings its
// request line went to. [LAW:types-are-the-program] Its draw is written only
// to those, so a recording started during the request's wait never holds a
// draw of a request it has no line for.
export interface Arrival {
  readonly at: Instant;
  readonly noted: ReadonlySet<object>;
}

// What a draw read: its view's document, the request the view was declared
// with, and what the session's clicks and menus left for it.
export interface DrawnFrom {
  readonly document: FactsLine;
  readonly declaration: ViewFacts;
  readonly state: DrawState;
}

interface Open {
  readonly sink: RecordingSink;
  detach: () => void;
  // The last document and the last declaration this recording wrote: what a
  // replay's view holds at the next line.
  document: SessionFacts | null;
  declaration: ViewFacts | null;
}

export function sessionRecorder(
  views: SessionViews,
  log: DaemonLogger,
): SessionRecorder {
  const open = new Map<string, Set<Open>>();
  // [LAW:no-ambient-temporal-coupling] The daemon's close is the recorder's
  // own state, so a record request handled after it is refused for what it
  // is, not for a view the close retired.
  let closed = false;
  const end = (sessionId: string, rec: Open, how: RecordingEnd): void => {
    const recs = open.get(sessionId);
    if (recs === undefined || !recs.delete(rec)) return;
    if (recs.size === 0) open.delete(sessionId);
    rec.detach();
    rec.sink.end(how);
  };
  // [LAW:single-enforcer] Every line a recording writes goes through here: a
  // write that throws ends that recording with the error, which its sink
  // reports, and no later line is offered.
  const write = (sessionId: string, rec: Open, line: RecordingLine): void => {
    try {
      rec.sink.write(line);
      if (line.kind === "facts") rec.document = line.facts;
      if (line.kind === "request" || line.kind === "declared") {
        rec.declaration = line.request;
      }
    } catch (e) {
      log("error", `recording sid=${JSON.stringify(sessionId)}: ${inspect(e)}`);
      end(sessionId, rec, { kind: "failed", error: e });
    }
  };
  // The session's current view, written from: its document now, then each it
  // takes. With no view, nothing, until the cache enters one.
  // [LAW:no-ambient-temporal-coupling] Each write is made holding its own
  // reaction's handle, so a write that ends the recording disposes the
  // reaction that made it — the first one included, which runs before
  // `reaction` has returned, or at the end of the batch it was entered in.
  const attach = (sessionId: string, rec: Open): void => {
    const view = views.sessionView(sessionId);
    rec.detach =
      view === null
        ? () => {}
        : reaction(
            () => view.followed.stamped(),
            (line, _prior, self) => {
              rec.detach = () => self.dispose();
              write(sessionId, rec, { kind: "facts", ...line });
            },
            { fireImmediately: true },
          );
  };
  return {
    record(session, sink) {
      if (closed) {
        throw new Error("the daemon is closing: it records nothing more");
      }
      const view = views.sessionView(session);
      if (view === null) {
        throw new Error(
          `no view of session ${JSON.stringify(session)} is open in this daemon: it has not drawn a bar here since the daemon started, or its view closed while it was idle`,
        );
      }
      const rec: Open = {
        sink,
        detach: () => {},
        document: null,
        declaration: null,
      };
      const recs = open.get(session) ?? new Set<Open>();
      open.set(session, recs.add(rec));
      write(session, rec, {
        kind: "recording",
        session,
        home: view.source.home(),
      });
      if (recs.has(rec)) attach(session, rec);
      return () => end(session, rec, { kind: "stopped" });
    },
    moved(sessionId) {
      for (const rec of open.get(sessionId) ?? []) {
        rec.detach();
        attach(sessionId, rec);
      }
    },
    arrived(sessionId, line) {
      const noted = new Set<Open>();
      for (const rec of open.get(sessionId) ?? []) {
        write(sessionId, rec, { kind: "request", ...line });
        noted.add(rec);
      }
      return { at: line.at, noted };
    },
    // [LAW:one-source-of-truth] A replay draws from the last document and the
    // last declaration before the draw line, so those are the ones the draw
    // read: each written again here when it is not the last this recording
    // wrote, as a request's held view the session moved away from has, and
    // the current view at the draw after that.
    drew(sessionId, { at: request, noted }, { document, declaration, state }) {
      for (const rec of open.get(sessionId) ?? []) {
        if (!noted.has(rec)) continue;
        const lines: RecordingLine[] = [
          ...(rec.document === document.facts
            ? []
            : [{ kind: "facts", ...document } as const]),
          ...(rec.declaration === declaration
            ? []
            : [{ kind: "declared", request: declaration } as const]),
          { kind: "draw", request, state },
        ];
        // A write that failed ended the recording: nothing more is offered.
        for (const line of lines) {
          if (open.get(sessionId)?.has(rec)) write(sessionId, rec, line);
        }
      }
    },
    close() {
      closed = true;
      for (const [sessionId, recs] of open) {
        for (const rec of recs) end(sessionId, rec, { kind: "closed" });
      }
    },
  };
}

// [LAW:single-enforcer] The one wiring of a recorder over a render cache: the
// cache `build` makes is handed the observer that tells the recorder its
// sessions' views moved, and the recorder reads views back from that cache.
// The daemon and the tests build their cache through here, so neither can
// leave the wiring out.
export function recordedCache<C extends SessionViews>(
  build: (observers: Pick<RenderCacheObservers, "onSessionViewMoved">) => C,
  log: DaemonLogger,
): { readonly cache: C; readonly recorder: SessionRecorder } {
  let cache: C | null = null;
  const recorder = sessionRecorder(
    {
      sessionView: (sessionId) => {
        // [LAW:no-silent-failure] The observer fires only once the cache
        // serves a view, so a read before `build` returned is a wiring bug.
        if (cache === null) {
          throw new Error(
            "a recorder read its cache before the cache was built",
          );
        }
        return cache.sessionView(sessionId);
      },
    },
    log,
  );
  cache = build({
    onSessionViewMoved: (sessionId) => recorder.moved(sessionId),
  });
  return { cache, recorder };
}

// [LAW:single-enforcer] A request's arrival at its session's view, in the
// request path's one place for it: the request line is noted from the view's
// declaration — the request it was just declared with — before the settle,
// so the line names the request the frame is drawn by and precedes every
// document the settle stamps.
export function settleRequest(
  recorder: Pick<SessionRecorder, "arrived">,
  view: Pick<SessionView, "sessionId" | "facts" | "settle">,
  at: Instant,
): Settling & { readonly arrival: Arrival } {
  const arrival = recorder.arrived(view.sessionId, {
    at,
    request: view.facts(),
  });
  return { ...view.settle(at), arrival };
}

// [LAW:single-enforcer] A request's answer, in the request path's one place
// for it: drawn from the view the request holds, then noted with the document,
// the declaration and the session's state that draw read. The note is taken in
// the draw's own turn, so nothing moves between the two, and only once the draw
// returned: an answer that threw drew nothing a replay could draw. The idle
// instant is the one the draw says it was handed (`MenuIdle.drawn`), because
// the frame it drew has moved the clock since.
export function drawRequest<
  T extends { readonly idleSince: Instant | undefined },
>(
  recorder: Pick<SessionRecorder, "drew">,
  view: Pick<SessionView, "sessionId" | "facts"> & {
    readonly source: Pick<SessionSource, "stamped" | "state">;
  },
  arrival: Arrival,
  draw: () => T,
): T {
  const drawn = draw();
  recorder.drew(view.sessionId, arrival, {
    document: view.source.stamped(),
    declaration: view.facts(),
    state: { ...view.source.state(), idleSince: drawn.idleSince },
  });
  return drawn;
}

// A recording that started and that a write or the close ended: the daemon
// failing, where a recording refused before it began is the request's fault.
export class RecordingFailed extends Error {
  override name = "RecordingFailed";
}

// [LAW:effects-at-boundaries] A recording into a file: created new, so a
// mistyped path wipes nothing and two recordings never write one file;
// written line by line, synchronously, so the file holds every line in the
// order taken and a write that fails ends the recording with its error; and
// closed after `seconds` on the clock, when the client that asked for it
// leaves, or when the recorder closes. A close that fails is the recording's
// error too: the file may not hold what was written to it.
export function recordToFile(
  recorder: Pick<SessionRecorder, "record">,
  clock: Pick<Timekeeper, "after">,
  session: SessionId,
  path: string,
  seconds: number,
  left: AbortSignal,
): Promise<Recorded> {
  return new Promise((resolve, reject) => {
    let fd: number;
    try {
      // Owner-only: it holds the session's paths, hints and usage.
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      reject(
        new Error(
          (e as NodeJS.ErrnoException).code === "EEXIST"
            ? `${path} already exists: a recording writes a new file`
            : `${path} cannot be created: ${String(e)}`,
        ),
      );
      return;
    }
    let lines = 0;
    // The answers drawn while it recorded: the frames a replay draws.
    let answers = 0;
    let stop = (): void => {};
    const clearTimer = clock.after(seconds * 1000, () => stop());
    const leave = (): void => stop();
    const sink: RecordingSink = {
      // A whole line or the write's error: one write call may take part of it.
      write: (line) => {
        appendFileSync(fd, formatLine(line));
        lines++;
        if (line.kind === "draw") answers++;
      },
      end: (how) => {
        clearTimer();
        left.removeEventListener("abort", leave);
        let error: unknown = how.kind === "failed" ? how.error : null;
        try {
          closeSync(fd);
          // A recording no request was answered in is one the parser refuses,
          // and it would refuse the same path to the next try: it is not kept.
          if (answers === 0) unlinkSync(path);
        } catch (e) {
          error ??= e;
        }
        if (error === null) {
          resolve({
            path,
            lines,
            answers,
            daemonClosed: how.kind === "closed",
          });
        } else {
          reject(new RecordingFailed(`writing ${path}: ${String(error)}`));
        }
      },
    };
    left.addEventListener("abort", leave, { once: true });
    try {
      stop = recorder.record(session, sink);
    } catch (e) {
      left.removeEventListener("abort", leave);
      // Nothing was written: the file this call created goes with it.
      clearTimer();
      closeSync(fd);
      unlinkSync(path);
      reject(e);
    }
  });
}
