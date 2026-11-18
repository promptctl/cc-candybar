// A daemon's connection: one request answered, or one session's frames pushed,
// over a stream. The socket is what a daemon's process hands it, and nothing
// here needs one, so a test runs a connection's behaviour in a jest worker.
// It needs two things of a stream that a socket gives by nature: Buffer chunks,
// and being destroyed when its peer vanishes, because a flush that never settles
// strands the exit.

import type { SessionId } from "./foundations/session-id.js";
import type { Duplex } from "node:stream";
import { inspect } from "node:util";
import type { Daemon } from "./daemon.js";
import { renderFailed } from "./foundations/render-answers.js";
import { NOTHING_TO_SETTLE } from "./statusline-answer.js";
import { LANE_FRAMES } from "./lane-frames";
import {
  PROTOCOL_VERSION,
  classifyInbound,
  encodeFrame,
  encodeJsonFrame,
  makeOneFrameReader,
  type Response,
} from "./foundations/protocol";
import type { HandledRequest, Reply } from "./reply.js";
import { type Lane } from "../config/lanes.js";
import { newestWins } from "../utils/newest-wins.js";
import { REQUEST_TIMEOUT_MS } from "./foundations/request-deadline.js";

// What a connection reads of its daemon.
export type ConnectionDaemon = Pick<
  Daemon,
  "stats" | "clock" | "handle" | "subscribe" | "exit" | "log"
>;

// [LAW:types-are-the-program] A connection's one state.
// - `awaiting`: no frame yet; a client is taken to wait.
// - `answering`: a request is read, and its client waits for the answer.
// - `unattended`: a url frame is read. The URL handler app waits for no
//   outcome, reading the verdict on its link at most, so its hanging up is its
//   design, not a peer leaving: the frame stays in flight until its click is
//   handled, under the same deadline every request has (a click past it is
//   refused, so a repeat click cannot revert it, src/daemon/reply.ts).
// - `answered`: the one answer is written.
// - `streaming`: the session's subscription stands.
// - `closed`: the peer has gone.
type Phase =
  | { readonly kind: "awaiting" }
  | { readonly kind: "answering" }
  | { readonly kind: "unattended" }
  | { readonly kind: "answered" }
  | { readonly kind: "streaming"; readonly unsubscribe: () => void }
  | { readonly kind: "closed" };

// A connection is in flight until it closes, or until it becomes a
// subscription, which daemon-stats counts as one of `frameFeeds.subscribers`
// instead.
const inFlight = (p: Phase): boolean =>
  p.kind !== "streaming" && p.kind !== "closed";

// While an answer is owed under the deadline.
const owed = (p: Phase): boolean =>
  p.kind === "awaiting" || p.kind === "answering" || p.kind === "unattended";

export function handleConnection(daemon: ConnectionDaemon, sock: Duplex): void {
  // [LAW:single-enforcer] A client that ends its side has ended the exchange:
  // the daemon's side ends with it, before any answer. Said here, so no stream
  // a connection runs over has to be built to say it.
  sock.allowHalfOpen = false;
  // [LAW:effects-at-boundaries] Which request this is and when it was
  // accepted, on the monotonic clock: a render says how long it waited from
  // here to begin.
  const accepted = daemon.stats.accept();
  daemon.stats.inFlight++;
  let phase: Phase = { kind: "awaiting" };
  // [LAW:one-source-of-truth] Whether the deadline passed: written once, by
  // the backstop, and read by everything that asks.
  let timedOut = false;

  // Per-request timeout protects the daemon from a single slow request
  // (e.g. a hung git call) blocking subsequent connections. It abandons the
  // RESPONSE, not the work in hand — the handler promise keeps running — though
  // a click still waiting for its turn is refused then (src/daemon/reply.ts).
  //
  // [LAW:one-source-of-truth] That is safe for the transcript-fs path because
  // the work is bounded + shared, not orphaned: the today aggregate and
  // per-session usage compute behind a SingleFlight (src/utils/single-flight.ts),
  // so a timed-out render that abandoned its await leaves behind the ONE
  // canonical in-flight scan, which the next render coalesces onto rather than
  // duplicating. A timeout therefore adds zero new fs work — there is never
  // more than one scan per key to orphan. Cancellation would be both messier
  // and wasteful here (the in-flight scan is exactly what the next tick needs).
  const clearBackstop = daemon.clock.after(REQUEST_TIMEOUT_MS, () => {
    timedOut = true;
    daemon.stats.requestsTimedOut++;
    // A url frame's click still runs, and is refused at its turn; a waiting
    // client is told now.
    if (phase.kind === "awaiting" || phase.kind === "answering")
      answer({
        ok: false,
        error: `request exceeded ${REQUEST_TIMEOUT_MS}ms`,
        code: "TIMEOUT",
        daemonV: PROTOCOL_VERSION,
        request: accepted.id,
      });
  });

  // [LAW:single-enforcer] The one move of the state. In flight and the
  // backstop are properties of it, so each changes exactly once, as a move
  // crosses its line; a backstop that already fired has nothing to clear.
  // `closed` is final: a peer that has gone stays gone, whatever is still on
  // its way to it.
  function move(next: Phase): void {
    if (phase.kind === "closed") return;
    if (inFlight(phase) && !inFlight(next)) daemon.stats.inFlight--;
    if (owed(phase) && !owed(next) && !timedOut) clearBackstop();
    phase = next;
  }

  // The one answer to a waiting client: the move and the write together. The
  // write settles what the answer owes even when the client has gone.
  function answer(
    resp: Response,
    exitAfterFlush: number | null = null,
    settled: (delivered: boolean) => void = NOTHING_TO_SETTLE,
  ): void {
    move({ kind: "answered" });
    write(resp, exitAfterFlush, settled);
  }

  // [LAW:no-ambient-temporal-coupling] The one write to the socket, which ends
  // the stream. exitAfterFlush (an exit code; null = stay up) is performed by
  // sock.end's completion callback, which Node invokes on 'finish' OR 'error' —
  // a total signal. A peer that vanished mid-flush still settles, so the exit
  // wish can never be stranded on a dead socket, and a live peer always has
  // the frame in the kernel buffer before process.exit (unix-socket data
  // survives writer exit). No fixed sleep stands between the write and the
  // exit; the SIGKILL backstop inside server.ts's shutdown() is the unrelated
  // last-resort safety.
  //
  // [LAW:no-silent-failure] An answer no reader would take (one that does not
  // serialize, or one past the frame cap) is answered RENDER_FAILED naming
  // why, which always fits, so a client is never left on a stream nothing
  // answers.
  function write(
    resp: Response,
    exitAfterFlush: number | null,
    // [LAW:single-enforcer] Told once, on every exit, whether the client took
    // this response: what a reply owes is settled even when it is never sent.
    settled: (delivered: boolean) => void,
  ): void {
    const settle =
      exitAfterFlush === null
        ? undefined
        : (): void => daemon.exit(exitAfterFlush);
    let frame: Buffer;
    let encoded = true;
    try {
      frame = encodeFrame(resp);
    } catch (e) {
      daemon.log("error", `response encode failed: ${inspect(e)}`);
      frame = encodeFrame(renderFailed(e));
      encoded = false;
    }
    try {
      // A peer that already left fails the flush (it ended its side), so a
      // clean one is the client holding the response.
      sock.end(frame, (err?: Error | null) => {
        settled(encoded && err == null);
        settle?.();
      });
    } catch (e) {
      // [LAW:no-silent-failure] The response is lost (socket already torn
      // down), but the exit wish must not be.
      daemon.log("warn", `response write failed: ${(e as Error).message}`);
      settled(false);
      settle?.();
    }
  }

  // [LAW:dataflow-not-control-flow] Whether a client waits for the answer is a
  // fact of what it sent. A frame read after the backstop answered still runs
  // its work, and its answer goes nowhere: a render read late warms the next
  // tick, and a click read late writes its refused click event.
  function framed(frame: unknown): void {
    const inbound = classifyInbound(frame);
    const waits = inbound.kind === "request";
    // A url frame's click runs however late it is read, so it is in flight
    // until it lands even when the backstop has already answered.
    if (!waits) move({ kind: "unattended" });
    else if (phase.kind === "awaiting") move({ kind: "answering" });
    // [LAW:single-enforcer] A handler that throws before its promise is one
    // that rejects: both are answered by the one catch below.
    new Promise<HandledRequest>((resolve) =>
      resolve(
        daemon.handle(
          inbound,
          () => timedOut,
          accepted,
          // A url frame's writer hangs up by design, so only a waiting
          // client can be said to have left.
          () => waits && sock.destroyed,
        ),
      ),
    )
      .then((r) => {
        switch (r.kind) {
          case "url":
            return clicked(r);
          case "reply":
            return replied(r);
          case "subscribe":
            return subscribed(r.sessionId, r.lane);
        }
      })
      // [LAW:no-silent-failure] Answered with the failure whoever sent the
      // frame: a request's client, or a URL handler that reads its verdict.
      // A version 1 writer has closed, and the write is only an error event.
      .catch((err: unknown) => {
        daemon.log("error", `handler threw: ${inspect(err)}`);
        if (phase.kind === "answering") answer(renderFailed(err));
        if (phase.kind === "unattended") {
          write(renderFailed(err), null, NOTHING_TO_SETTLE);
          move({ kind: "closed" });
        }
      });
  }

  function unparsed(err: Error): void {
    daemon.log("warn", `frame parse failed: ${err.message}`);
    if (phase.kind === "awaiting")
      answer({
        ok: false,
        error: err.message,
        code: "BAD_REQUEST",
        daemonV: PROTOCOL_VERSION,
      });
  }

  // A url frame's verdict is a write under the deadline its click still runs
  // under, and the socket's one answer all the same. It is in flight until its
  // click has landed. A version 1 writer has closed, and a write to its socket
  // is only an error event.
  function clicked(r: Extract<HandledRequest, { kind: "url" }>): void {
    if (phase.kind === "unattended" && r.awaitsVerdict)
      write(r.verdict, null, NOTHING_TO_SETTLE);
    void r
      .land()
      .catch((err: unknown) =>
        daemon.log("error", `url click threw: ${inspect(err)}`),
      )
      .finally(() => {
        if (phase.kind === "unattended") move({ kind: "closed" });
      });
  }

  // An exit is sequenced on its own reply's flush (reply.ts), so a reply that
  // will never be sent takes its exit with it: a busy daemon reads a request
  // the backstop has already answered. That client heard TIMEOUT, not an exit,
  // and a statusline client asks again on its next tick. Say so, because a
  // daemon told to exit is staying up. [LAW:no-silent-failure] A client that
  // hung up is written to all the same: the flush fails, and the exit the
  // reply carries runs on that failure as it would on success.
  function replied(r: Reply): void {
    if (timedOut) {
      if (r.exitAfterFlush !== null)
        daemon.log(
          "warn",
          "exit-after-flush dropped: the client was already told TIMEOUT",
        );
      r.settled(false);
      return;
    }
    answer(r.resp, r.exitAfterFlush, r.settled);
  }

  // The connection becomes the session's subscription: no reply, no request
  // timeout, and frames until the subscriber closes it. Only a waiting
  // client's subscribe attaches: one the backstop answered while it was on its
  // way, or whose subscriber hung up first, is not a subscription.
  // [LAW:no-ambient-temporal-coupling] A subscriber slower than the frames
  // gets the newest one when its socket drains, never a backlog of stale ones.
  function subscribed(sessionId: SessionId, lane: Lane): void {
    if (phase.kind !== "answering") {
      daemon.log(
        "info",
        `subscribe sid=${JSON.stringify(sessionId)} lane=${lane} not attached: the connection is ${phase.kind}`,
      );
      return;
    }
    const send = newestWins(sock);
    // A subscribe that throws stays answering, and is answered RENDER_FAILED
    // and ended by the throw, never an open socket nothing feeds.
    const unsubscribe = daemon.subscribe(sessionId, {
      lane,
      // [LAW:no-silent-failure] A frame past the cap ends the stream with
      // why, as a reply past it is answered, never pushed for every reader
      // to refuse.
      frame: (bar, json) => {
        let encoded: Buffer;
        try {
          encoded = encodeJsonFrame(LANE_FRAMES[lane](bar, json));
        } catch (e) {
          daemon.log("error", `pushed frame encode failed: ${inspect(e)}`);
          write(renderFailed(e), null, NOTHING_TO_SETTLE);
          return;
        }
        send(encoded);
      },
      // A refused subscription is over: its refusal ends the stream, and a
      // frame still waiting for the socket to drain is dropped, as
      // newest-wins drops any frame a newer one replaces.
      refused: (resp) => write(resp, null, NOTHING_TO_SETTLE),
      drawing: () => true,
    });
    move({ kind: "streaming", unsubscribe });
  }

  // [LAW:single-enforcer] A connection carries one frame: the reader settles
  // at its first frame or its first error, and reads nothing after.
  sock.on("data", makeOneFrameReader(framed, unparsed));
  sock.on("error", (err) => {
    daemon.log("warn", `socket error: ${err.message}`);
  });
  sock.on("close", () => {
    switch (phase.kind) {
      case "streaming":
        phase.unsubscribe();
        move({ kind: "closed" });
        return;
      // A url frame's writer hangs up by design: it stays in flight until its
      // click has landed.
      case "unattended":
      case "closed":
        return;
      case "awaiting":
      case "answering":
      case "answered":
        move({ kind: "closed" });
        return;
    }
  });
}
