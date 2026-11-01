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
import { LANE_FRAMES } from "./lane-frames";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  encodeJsonFrame,
  makeFrameReader,
} from "./protocol";
import type { Request, Response } from "./protocol";
import { type Lane } from "../config/lanes.js";
import { newestWins } from "../utils/newest-wins.js";
import { REQUEST_TIMEOUT_MS } from "./request-deadline.js";

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
  daemon.stats.inFlight++;
  let responded = false;
  // A connection is in flight until it is answered and closes, or until it
  // becomes a subscription, which daemon-stats counts as one of
  // `frameFeeds.subscribers` instead.
  let counted = true;
  const leaveInFlight = (): void => {
    if (!counted) return;
    counted = false;
    daemon.stats.inFlight--;
  };

  // [LAW:no-ambient-temporal-coupling] respond owns the response→exit
  // ordering. exitAfterFlush (an exit code; null = stay up) is performed
  // by sock.end's completion callback, which Node invokes on 'finish' OR
  // 'error' — a total signal. A peer that vanished mid-flush still settles,
  // so the exit wish can never be stranded on a dead socket, and a live
  // peer always has the frame in the kernel buffer before process.exit
  // (unix-socket data survives writer exit). No fixed sleep stands between
  // respond and exit; the SIGKILL backstop inside server.ts's shutdown() is
  // the unrelated last-resort safety.
  const respond = (
    resp: Response,
    exitAfterFlush: number | null,
    delivered: () => void,
  ): void => {
    if (responded) {
      // First responder owns the flush. An exit is sequenced on its own
      // reply's flush (reply.ts), so a reply that will never be sent takes its
      // exit with it: a busy daemon reads a request the backstop has already
      // answered. That client heard TIMEOUT, not an exit, and a statusline
      // client asks again on its next tick. Say so, because a daemon told to
      // exit is staying up. [LAW:no-silent-failure]
      if (exitAfterFlush !== null) {
        daemon.log(
          "warn",
          "exit-after-flush dropped: an earlier responder settled this socket",
        );
      }
      return;
    }
    responded = true;
    clearBackstop();
    const settle =
      exitAfterFlush === null
        ? undefined
        : (): void => daemon.exit(exitAfterFlush);
    try {
      // A peer that already left fails the flush (it ended its side), so a
      // clean one is the client holding the response.
      sock.end(encodeFrame(resp), (err?: Error | null) => {
        if (err == null) delivered();
        settle?.();
      });
    } catch (e) {
      // [LAW:no-silent-failure] The response is lost (socket already torn
      // down), but the exit wish must not be.
      daemon.log("warn", `response write failed: ${(e as Error).message}`);
      settle?.();
    }
  };

  // Per-request timeout protects the daemon from a single slow request
  // (e.g. a hung git call) blocking subsequent connections. It abandons the
  // RESPONSE, not the work — the handler promise keeps running.
  //
  // [LAW:one-source-of-truth] That is safe for the transcript-fs path because
  // the work is bounded + shared, not orphaned: the today aggregate and
  // per-session usage compute behind a SingleFlight (src/utils/single-flight.ts),
  // so a timed-out render that abandoned its await leaves behind the ONE
  // canonical in-flight scan, which the next render coalesces onto rather than
  // duplicating. A timeout therefore adds zero new fs work — there is never
  // more than one scan per key to orphan. Cancellation would be both messier
  // and wasteful here (the in-flight scan is exactly what the next tick needs).
  let timedOut = false;
  const clearBackstop = daemon.clock.after(REQUEST_TIMEOUT_MS, () => {
    timedOut = true;
    daemon.stats.requestsTimedOut++;
    respond(
      {
        ok: false,
        error: `request exceeded ${REQUEST_TIMEOUT_MS}ms`,
        code: "TIMEOUT",
        daemonV: PROTOCOL_VERSION,
      },
      null,
      NOTHING_DELIVERED,
    );
  });

  const reader = makeFrameReader(
    (frame) => {
      void daemon
        .handle(frame as Request, () => timedOut || sock.destroyed, accepted)
        .then((r) =>
          r.kind === "reply"
            ? respond(r.resp, r.exitAfterFlush, r.delivered)
            : stream(r.sessionId, r.lane),
        )
        .catch((err: unknown) => {
          daemon.log("error", `handler threw: ${inspect(err)}`);
          respond(renderFailed(err), null, NOTHING_DELIVERED);
        });
    },
    (err) => {
      daemon.log("warn", `frame parse failed: ${err.message}`);
      respond(
        {
          ok: false,
          error: err.message,
          code: "BAD_REQUEST",
          daemonV: PROTOCOL_VERSION,
        },
        null,
        NOTHING_DELIVERED,
      );
    },
  );

  // The connection becomes the session's subscription: no reply, no request
  // timeout, and frames until the subscriber closes it. It carries frames one
  // way only, so anything more the subscriber sends is not read.
  // [LAW:no-ambient-temporal-coupling] A subscriber slower than the frames
  // gets the newest one when its socket drains, never a backlog of stale ones.
  const stream = (sessionId: string, lane: Lane): void => {
    // A connection the request timer already answered — TIMEOUT, then ended, while a cold or busy
    // daemon had not yet read the subscribe — is not a subscription: its socket is closing, and a
    // feed attached to it would never hear the close. The subscriber was told, and opens another.
    if (responded) return;
    // A subscriber that hung up before its subscribe was handled: its close has
    // already fired, so a feed attached now would never hear it.
    if (sock.destroyed) return;
    clearBackstop();
    leaveInFlight();
    sock.off("data", reader);
    const write = newestWins(sock);
    const unsubscribe = daemon.subscribe(sessionId, {
      lane,
      frame: (resp, json) =>
        write(encodeJsonFrame(LANE_FRAMES[lane](resp, json))),
      // A refused subscription is over: its refusal ends the stream, and a
      // frame still waiting for the socket to drain is dropped, as
      // newest-wins drops any frame a newer one replaces.
      refused: (resp) => sock.end(encodeFrame(resp)),
      drawing: () => true,
    });
    // Answered only once the subscription stands: a subscribe that threw is
    // the connection's `handler threw`, answered RENDER_FAILED and ended,
    // never an open socket nothing feeds.
    responded = true;
    sock.on("close", unsubscribe);
  };

  sock.on("data", reader);
  sock.on("error", (err) => {
    daemon.log("warn", `socket error: ${err.message}`);
  });
  sock.on("close", () => {
    clearBackstop();
    leaveInFlight();
  });
}
