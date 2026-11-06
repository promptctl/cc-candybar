// A session's recording: its stream written out of the running daemon, line
// by line, as a recording a renderer replays offline (src/facts/recording.ts,
// docs/design/gather-and-renderer.md §14) — the documents its view takes and
// the requests it is drawn by.
//
// [LAW:one-source-of-truth] A recording follows the session's current view as
// the render cache holds it, and keeps no record of views of its own: the
// cache says when the session's view changes, and the recording reads the
// view back from the cache. A view whose open failed is never entered, and a
// view the cache dropped is left in the same call, so one view writes at a
// time — the cache's current one. A successor's opening document starts its
// sequence again, which a replay shows at its instant as the live bar did.

import { inspect } from "node:util";
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { reaction } from "mobx";
import {
  formatLine,
  type RecordingLine,
  type RequestLine,
} from "../facts/recording.js";
import type { Timekeeper } from "../time.js";
import type { Instant } from "../utils/instant.js";
import type { DaemonLogger } from "../utils/logger.js";
import type { RenderCacheObservers, SessionView } from "./cache/render.js";
import type { Settling } from "./facts-source.js";
import type { Recorded } from "./protocol.js";
import type { SessionId } from "./session-id.js";

// What a recording reads of the cache: the session's current view.
export interface SessionViews {
  sessionView(sessionId: string): Pick<SessionView, "followed"> | null;
}

// Where a recording's lines go, and what hears it end: `failure` is null for
// a recording that ran its course or was stopped, and the write's error for
// one a write ended.
export interface RecordingSink {
  write(line: RecordingLine): void;
  end(failure: unknown): void;
}

export interface SessionRecorder {
  // Starts recording the session into `sink`: the header, the current view's
  // document, then each document and request as they come. Returns its stop.
  // [LAW:no-silent-failure] A session the cache holds no view for is refused,
  // naming it: there is nothing of it here to record.
  record(session: SessionId, sink: RecordingSink): () => void;
  // The cache's say that the session's current view changed.
  moved(sessionId: string): void;
  // A request arrived at the session's view (`settleRequest`).
  arrived(sessionId: string, line: RequestLine): void;
  // Every open recording ends: the daemon is closing.
  close(): void;
}

interface Open {
  readonly sink: RecordingSink;
  detach: () => void;
}

export function sessionRecorder(
  views: SessionViews,
  log: DaemonLogger,
): SessionRecorder {
  const open = new Map<string, Set<Open>>();
  const end = (sessionId: string, rec: Open, failure: unknown): void => {
    const recs = open.get(sessionId);
    if (recs === undefined || !recs.delete(rec)) return;
    if (recs.size === 0) open.delete(sessionId);
    rec.detach();
    rec.sink.end(failure);
  };
  // [LAW:single-enforcer] Every line a recording writes goes through here: a
  // write that throws ends that recording with the error, which its sink
  // reports, and no later line is offered.
  const write = (sessionId: string, rec: Open, line: RecordingLine): void => {
    try {
      rec.sink.write(line);
    } catch (e) {
      log("error", `recording sid=${JSON.stringify(sessionId)}: ${inspect(e)}`);
      end(sessionId, rec, e);
    }
  };
  // The session's current view, written from: its document now, then each it
  // takes. With no view, nothing, until the cache enters one.
  const attach = (sessionId: string, rec: Open): void => {
    const view = views.sessionView(sessionId);
    rec.detach =
      view === null
        ? () => {}
        : reaction(
            () => view.followed.stamped(),
            (line) => write(sessionId, rec, { kind: "facts", ...line }),
            { fireImmediately: true },
          );
  };
  return {
    record(session, sink) {
      if (views.sessionView(session) === null) {
        throw new Error(
          `no view of session ${JSON.stringify(session)} is open in this daemon: it has not drawn a bar here since the daemon started, or its view closed while it was idle`,
        );
      }
      const rec: Open = { sink, detach: () => {} };
      const recs = open.get(session) ?? new Set<Open>();
      open.set(session, recs.add(rec));
      write(session, rec, { kind: "recording", session });
      if (recs.has(rec)) attach(session, rec);
      return () => end(session, rec, null);
    },
    moved(sessionId) {
      for (const rec of open.get(sessionId) ?? []) {
        rec.detach();
        attach(sessionId, rec);
      }
    },
    arrived(sessionId, line) {
      for (const rec of open.get(sessionId) ?? []) {
        write(sessionId, rec, { kind: "request", ...line });
      }
    },
    close() {
      for (const [sessionId, recs] of open) {
        for (const rec of recs) end(sessionId, rec, null);
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
): Settling {
  recorder.arrived(view.sessionId, { at, request: view.facts() });
  return view.settle(at);
}

// [LAW:effects-at-boundaries] A recording into a file: created new, so a
// mistyped path wipes nothing and two recordings never write one file;
// written line by line, synchronously, so the file holds every line in the
// order taken and a write that fails ends the recording with its error; and
// closed after `seconds` on the clock, or when the recorder closes.
export function recordToFile(
  recorder: Pick<SessionRecorder, "record">,
  clock: Pick<Timekeeper, "after">,
  session: SessionId,
  path: string,
  seconds: number,
): Promise<Recorded> {
  return new Promise((resolve, reject) => {
    let fd: number;
    try {
      fd = openSync(path, "wx");
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
    let requests = 0;
    let stop = (): void => {};
    const clearTimer = clock.after(seconds * 1000, () => stop());
    const sink: RecordingSink = {
      write: (line) => {
        writeSync(fd, formatLine(line));
        lines++;
        if (line.kind === "request") requests++;
      },
      end: (failure) => {
        clearTimer();
        closeSync(fd);
        if (failure === null) resolve({ path, lines, requests });
        else reject(new Error(`writing ${path}: ${String(failure)}`));
      },
    };
    try {
      stop = recorder.record(session, sink);
    } catch (e) {
      // Nothing was written: the file this call created goes with it.
      clearTimer();
      closeSync(fd);
      unlinkSync(path);
      reject(e);
    }
  });
}
