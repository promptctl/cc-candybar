// A daemon's connection: one request answered, or one session's frames pushed,
// over a stream. The socket is what a daemon's process hands it, and nothing
// here needs one, so a test runs a connection's behaviour in a jest worker.
// It needs two things of a stream that a socket gives by nature: Buffer chunks,
// and being destroyed when its peer vanishes, because a flush that never settles
// strands the exit.

import type { Duplex } from "node:stream";
import { inspect } from "node:util";
import type { Daemon } from "./daemon.js";
import { NOTHING_DELIVERED, renderFailed } from "./draw-bar.js";
import {
  PROTOCOL_VERSION,
  classifyInbound,
  encodeFrame,
  encodeJsonFrame,
  readOneFrame,
} from "./protocol";
import type { Response } from "./protocol";
import { stay, type HandledRequest, type Reply } from "./reply.js";
import { type Lane } from "../config/lanes.js";
import { newestWins } from "../utils/newest-wins.js";
import { REQUEST_TIMEOUT_MS } from "./request-deadline.js";
import type { SessionId } from "./session-id.js";
import {
  AWAITING,
  clientLeft,
  step,
  timedOut,
  type ConnectionEffect,
  type ConnectionEvent,
  type ConnectionState,
} from "./connection-state.js";

// What a connection reads of its daemon.
export type ConnectionDaemon = Pick<
  Daemon,
  "stats" | "clock" | "handle" | "subscribe" | "exit" | "log"
>;

export function handleConnection(daemon: ConnectionDaemon, sock: Duplex): void {
  // [LAW:single-enforcer] A client that ends its side has ended the exchange:
  // the daemon's side ends with it, before any answer. Said here, so no stream
  // a connection runs over has to be built to say it.
  sock.allowHalfOpen = false;
  // [LAW:effects-at-boundaries] When the connection was accepted, on the
  // monotonic clock: a render says how long it waited from here to begin.
  const accepted = daemon.clock.monotonic();
  // A connection is in flight from its accept until it closes, or until it
  // becomes a subscription, which daemon-stats counts as one of
  // `frameFeeds.subscribers` instead (src/daemon/connection-state.ts).
  daemon.stats.inFlight++;
  // [LAW:types-are-the-program] The connection's one state, moved only by
  // `on`; everything below performs the effects a step names.
  let state: ConnectionState = AWAITING;
  const on = (event: ConnectionEvent): void => {
    const { next, effects } = step(state, event);
    state = next;
    effects.forEach(perform);
  };
  // What a held request is told when its client hangs up.
  const left = new AbortController();

  const perform = (effect: ConnectionEffect): void => {
    switch (effect.kind) {
      case "answer":
        return answer(effect.answer);
      case "exit":
        return daemon.exit(effect.code);
      case "exit-dropped":
        // A busy daemon read a request the backstop had already answered. That
        // client heard TIMEOUT, not an exit, and a statusline client asks
        // again on its next tick.
        return daemon.log(
          "warn",
          "exit-after-flush dropped: the client was already told TIMEOUT",
        );
      case "count-timeout":
        daemon.stats.requestsTimedOut++;
        return;
      case "clear-backstop":
        return clearBackstop();
      case "leave-in-flight":
        daemon.stats.inFlight--;
        return;
      case "attach":
        // The subscription stands only once the feed took it: a subscribe
        // that throws is the connection's `handler threw`, answered
        // RENDER_FAILED and ended, never an open stream nothing feeds.
        return on({
          kind: "subscribed",
          unsubscribe: attach(effect.sessionId, effect.lane),
        });
      case "start":
        return start(effect.start);
      case "abort":
        return left.abort();
      case "unsubscribe":
        return effect.unsubscribe();
    }
  };

  // [LAW:no-ambient-temporal-coupling] An answer owns its response→exit
  // ordering. exitAfterFlush (an exit code; null = stay up) is performed
  // by sock.end's completion callback, which Node invokes on 'finish' OR
  // 'error' — a total signal. A peer that vanished mid-flush still settles,
  // so the exit wish can never be stranded on a dead socket, and a live
  // peer always has the frame in the kernel buffer before process.exit
  // (unix-socket data survives writer exit). No fixed sleep stands between
  // the answer and exit; the SIGKILL backstop inside server.ts's shutdown() is
  // the unrelated last-resort safety.
  const answer = ({ resp, exitAfterFlush, delivered }: Reply): void => {
    const settle =
      exitAfterFlush === null
        ? undefined
        : (): void => daemon.exit(exitAfterFlush);
    const [bytes, holds] = encoded(resp, delivered);
    try {
      // A peer that already left fails the flush (it ended its side), so a
      // clean one is the client holding the response.
      sock.end(bytes, (err?: Error | null) => {
        if (err == null) holds();
        settle?.();
      });
    } catch (e) {
      // [LAW:no-silent-failure] The response is lost (socket already torn
      // down), but the exit wish must not be.
      daemon.log("warn", `response write failed: ${(e as Error).message}`);
      settle?.();
    }
  };

  // [LAW:no-silent-failure] An answer that cannot be encoded (a BigInt, a
  // cycle, a string past V8's limit) is still answered: RENDER_FAILED, naming
  // the failure. That answer is strings only, so it always encodes, and its
  // client holds a failure, not the reply's delivery.
  const encoded = (
    resp: Response,
    delivered: () => void,
  ): readonly [Buffer, () => void] => {
    try {
      return [encodeFrame(resp), delivered];
    } catch (e) {
      daemon.log("error", `response encode failed: ${inspect(e)}`);
      return [encodeFrame(renderFailed(e)), NOTHING_DELIVERED];
    }
  };

  // Per-request timeout protects the daemon from a single slow request
  // (e.g. a hung git call) blocking subsequent connections. It abandons the
  // RESPONSE, not the work in hand — the handler promise keeps running — though
  // a click still waiting for its turn is refused then (src/daemon/journal-turns.ts).
  //
  // [LAW:one-source-of-truth] That is safe for the transcript-fs path because
  // the work is bounded + shared, not orphaned: the today aggregate and
  // per-session usage compute behind a SingleFlight (src/utils/single-flight.ts),
  // so a timed-out render that abandoned its await leaves behind the ONE
  // canonical in-flight scan, which the next render coalesces onto rather than
  // duplicating. A timeout therefore adds zero new fs work — there is never
  // more than one scan per key to orphan. Cancellation would be both messier
  // and wasteful here (the in-flight scan is exactly what the next tick needs).
  // The state clears it on leaving the states it is armed in.
  const clearBackstop = daemon.clock.after(REQUEST_TIMEOUT_MS, () =>
    on({
      kind: "deadline",
      answer: stay({
        ok: false,
        error: `request exceeded ${REQUEST_TIMEOUT_MS}ms`,
        code: "TIMEOUT",
        daemonV: PROTOCOL_VERSION,
      }),
    }),
  );

  // The connection becomes the session's subscription: no reply, no request
  // timeout, and frames until the subscriber closes it. It carries frames one
  // way only, and nothing more the subscriber sends is read.
  // [LAW:no-ambient-temporal-coupling] A subscriber slower than the frames
  // gets the newest one when its socket drains, never a backlog of stale ones.
  const attach = (sessionId: SessionId, lane: Lane): (() => void) => {
    const write = newestWins(sock);
    return daemon.subscribe(sessionId, {
      lane,
      // The frame as the feed encoded it for the lane, once for every
      // subscriber of it (src/daemon/lane-frames.ts).
      frame: (out) => write(encodeJsonFrame(out.json)),
      // A refused subscription is over: its refusal ends the stream, and a
      // frame still waiting for the socket to drain is dropped, as
      // newest-wins drops any frame a newer one replaces.
      refused: (resp) => sock.end(encodeFrame(resp)),
      drawing: () => true,
    });
  };

  // A held request is answered past the request timeout by design (a
  // recording, answered when its file closes). Its work starts only while a
  // client waits for it, and one that hangs up later stops the work it
  // started, as a stream's close ends its subscription.
  const start = (work: (left: AbortSignal) => Promise<Reply>): void => {
    work(left.signal).then(
      (r) => on({ kind: "reply", ...r }),
      (err: unknown) => {
        daemon.log("error", `held request threw: ${inspect(err)}`);
        on({ kind: "threw", answer: stay(renderFailed(err)) });
      },
    );
  };

  // [LAW:single-enforcer] One frame per connection: a request has one answer,
  // so nothing more its client sends is read, and a frame that does not parse
  // is answered once however its sender writes on.
  readOneFrame(
    sock,
    (frame) => {
      // [LAW:no-silent-failure] The frame's handling runs inside one promise,
      // started in the read's own turn, so a throw before its first await is
      // the daemon's failure, answered RENDER_FAILED like any later one, and
      // never an exception out of the socket's read that ends every session.
      void new Promise<HandledRequest>((resolve) => {
        const inbound = classifyInbound(frame);
        // [LAW:dataflow-not-control-flow] Whether a client waits for the
        // answer is a fact of what it sent, and the read carries it into the
        // state.
        on({ kind: "read", waits: inbound.kind === "request" });
        resolve(
          daemon.handle(
            inbound,
            () => timedOut(state),
            accepted,
            () => clientLeft(state),
          ),
        );
      })
        .then(on)
        .catch((err: unknown) => {
          daemon.log("error", `handler threw: ${inspect(err)}`);
          on({ kind: "threw", answer: stay(renderFailed(err)) });
        })
        .finally(() => on({ kind: "settled" }));
    },
    (err) => {
      daemon.log("warn", `frame parse failed: ${err.message}`);
      on({
        kind: "unreadable",
        answer: stay({
          ok: false,
          error: err.message,
          code: "BAD_REQUEST",
          daemonV: PROTOCOL_VERSION,
        }),
      });
    },
  );
  // [LAW:one-source-of-truth] An error is the peer leaving too: it destroys the
  // socket at once, while 'close' waits for the handle to close, so a click
  // whose turn falls between would otherwise run for a client already gone.
  sock.on("error", (err) => {
    daemon.log("warn", `socket error: ${err.message}`);
    on({ kind: "close" });
  });
  sock.on("close", () => on({ kind: "close" }));
}
