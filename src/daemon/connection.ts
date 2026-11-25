// A daemon's connection: one request answered, or one session's frames pushed,
// over a stream. The socket is what a daemon's process hands it, and nothing
// here needs one, so a test runs a connection's behaviour in a jest worker.
// It needs two things of a stream that a socket gives by nature: Buffer chunks,
// and being destroyed when its peer vanishes, because a flush that never settles
// strands the exit.

import type { SessionId } from "./foundations/session-id.js";
import type { Duplex } from "node:stream";
import { inspect } from "node:util";
import type { ServedDaemon } from "./daemon.js";
import { framed, renderFailed } from "./foundations/render-answers.js";
import { NOTHING_TO_SETTLE } from "./statusline-answer.js";
import {
  PROTOCOL_VERSION,
  classifyInbound,
  makeFrameReader,
  type Inbound,
  type Response,
} from "./foundations/protocol";
import {
  replyOf,
  withClientActs,
  type HandledRequest,
  type Reply,
} from "./reply.js";
import { type Lane } from "../config/lanes.js";
import type { PaneOwner } from "./frame-feed.js";
import { newestWins } from "../utils/newest-wins.js";
import {
  REQUEST_TIMEOUT_MS,
  backstopBoundsRead,
  timeoutResponse,
} from "./foundations/request-deadline.js";

// What a connection reads of its daemon.
export type ConnectionDaemon = Pick<
  ServedDaemon,
  "stats" | "clock" | "handle" | "subscribe" | "exit" | "log"
>;

// What an answer owes its sender once its fate is known: the exit it carries,
// and whether the client took it.
type Owed = Pick<Reply, "exitAfterFlush" | "settled">;
const OWES_NOTHING: Owed = { exitAfterFlush: null, settled: NOTHING_TO_SETTLE };

// [LAW:types-are-the-program] A connection's one state.
// - `awaiting`: no frame yet; a client is taken to wait.
// - `answering`: a request is read, and its client waits for the answer under
//   the backstop.
// - `held`: a request the backstop does not bound once read, per its kind
//   (`BACKSTOP_BOUNDS_READ`): its client waits for the answer, however long it
//   takes.
// - `unattended`: a url frame is read. The URL handler app waits for no
//   outcome, reading the verdict on its link at most, so its hanging up is its
//   design, not a peer leaving: the frame stays in flight until its click is
//   handled, however long that takes. `told`: its writer was written its
//   verdict, the socket's one answer.
// - `answered`: the socket's one answer is written: the reply (a refusal of
//   a subscribe included), or the backstop's TIMEOUT.
// - `streaming`: the session's subscription stands.
// - `closed`: over, and nothing more is sent: the peer has gone, a url
//   frame's click is done, or a stream was refused. `from` is the phase it ended in, so whether the
//   deadline passed and whether a waiting client left stay readable.
type Open =
  | { readonly kind: "awaiting" }
  | { readonly kind: "answering" }
  | { readonly kind: "held" }
  | { readonly kind: "unattended"; readonly told: boolean }
  | { readonly kind: "answered"; readonly by: "reply" | "backstop" }
  | { readonly kind: "streaming"; readonly unsubscribe: () => void };
type Phase = Open | { readonly kind: "closed"; readonly from: Open };

// What happens to a connection, carrying the answer it would send.
type Event =
  | { readonly kind: "read"; readonly opens: Open }
  | { readonly kind: "unparsed"; readonly answer: Reply }
  | { readonly kind: "deadline"; readonly answer: Reply }
  | { readonly kind: "replied"; readonly answer: Reply }
  | {
      readonly kind: "verdict";
      readonly answer: Reply;
      readonly awaited: boolean;
    }
  | { readonly kind: "failed"; readonly answer: Reply }
  | { readonly kind: "landed" }
  | { readonly kind: "refused"; readonly answer: Reply }
  | {
      readonly kind: "subscribe";
      readonly sessionId: SessionId;
      readonly lane: Lane;
      readonly owner: PaneOwner | null;
    }
  | { readonly kind: "attached"; readonly unsubscribe: () => void }
  | { readonly kind: "close" };

// What a step does besides moving the state.
type Act =
  | { readonly kind: "none" }
  | { readonly kind: "write"; readonly answer: Reply }
  | {
      readonly kind: "drop";
      readonly what: string;
      readonly owed: Owed;
      readonly why: string;
    }
  | {
      readonly kind: "attach";
      readonly sessionId: SessionId;
      readonly lane: Lane;
      readonly owner: PaneOwner | null;
    }
  | { readonly kind: "unsubscribe"; readonly unsubscribe: () => void };

type Step = readonly [Phase, Act];

// A connection is in flight until it is over, or until it becomes a
// subscription, which daemon-stats counts as one of `frameFeeds.subscribers`
// instead.
const inFlight = (p: Phase): boolean =>
  p.kind !== "streaming" && p.kind !== "closed";

// While the backstop is armed: an answer is owed under the deadline. `held`
// and `unattended` are not armed: reading either disarms the backstop.
const armed = (p: Phase): boolean =>
  p.kind === "awaiting" || p.kind === "answering";

// [LAW:one-source-of-truth] Whether the deadline passed, read off the phase.
function lapsed(p: Phase): boolean {
  switch (p.kind) {
    case "answered":
      return p.by === "backstop";
    case "closed":
      return lapsed(p.from);
    case "awaiting":
    case "answering":
    case "held":
    case "unattended":
    case "streaming":
      return false;
  }
}

// [LAW:one-source-of-truth] Whether a client that waited for its answer hung
// up before it came. A url frame's writer never waited, so it never left.
const left = (p: Phase): boolean =>
  p.kind === "closed" &&
  (p.from.kind === "awaiting" ||
    p.from.kind === "answering" ||
    p.from.kind === "held");

// [LAW:dataflow-not-control-flow] What a frame puts a waiting connection in is
// a fact of what was sent.
const opened = (inbound: Inbound): Open =>
  inbound.kind === "url"
    ? { kind: "unattended", told: false }
    : backstopBoundsRead(inbound.req?.kind)
      ? { kind: "answering" }
      : { kind: "held" };

const NONE: Act = { kind: "none" };
const write = (answer: Reply): Act => ({ kind: "write", answer });
const dropped = (p: Phase, owed: Owed, what = "answer"): Act => ({
  kind: "drop",
  what,
  owed,
  why: lapsed(p)
    ? "the client was already told TIMEOUT"
    : `the connection is ${p.kind}`,
});

// [LAW:types-are-the-program] Every transition, as what each event does in
// each phase. The table is total over both, so a move it does not name
// cannot be made, and no handler reads the phase to decide for itself.
const STEP: {
  readonly [K in Event["kind"]]: (
    p: Phase,
    e: Extract<Event, { kind: K }>,
  ) => Step;
} = {
  // [LAW:dataflow-not-control-flow] Whether a client waits for the answer is
  // a fact of what it sent. A frame read in any later phase moves nothing:
  // its work runs, and its answer goes nowhere. A render read late warms the
  // next tick.
  read: (p, e) => (p.kind === "awaiting" ? [e.opens, NONE] : [p, NONE]),
  unparsed: (p, e) =>
    p.kind === "awaiting"
      ? [{ kind: "answered", by: "reply" }, write(e.answer)]
      : [p, dropped(p, e.answer)],
  deadline: (p, e) => {
    switch (p.kind) {
      case "awaiting":
      case "answering":
        return [{ kind: "answered", by: "backstop" }, write(e.answer)];
      // A deadline deferred before the frame was read still arrives in `held`
      // or `unattended`, and moves nothing: reading the frame disarmed the
      // backstop (`armed`). A click's wait ends with its own outcome or its
      // client, and a url frame's click runs however late its turn comes.
      case "held":
      case "unattended":
      case "answered":
      case "streaming":
      case "closed":
        return [p, NONE];
    }
  },
  // An exit is sequenced on its own reply's flush (reply.ts), so a reply that
  // will never be sent takes its exit with it: a busy daemon reads a request
  // the backstop has already answered. That client heard TIMEOUT, not an
  // exit, and a statusline client asks again on its next tick.
  replied: (p, e) => {
    switch (p.kind) {
      case "answering":
      case "held":
        return [{ kind: "answered", by: "reply" }, write(e.answer)];
      // [LAW:no-silent-failure] A client that hung up waiting is written to
      // all the same: the flush fails, and the exit the reply carries runs on
      // that failure as it would on success.
      case "closed":
        return p.from.kind === "answering" || p.from.kind === "held"
          ? [p, write(e.answer)]
          : [p, dropped(p, e.answer)];
      case "awaiting":
      case "unattended":
      case "answered":
      case "streaming":
        return [p, dropped(p, e.answer)];
    }
  },
  // The app is told at once whether its link opened, when it reads that, and
  // the click runs on, still unattended. A url frame read
  // after the backstop answered is told nothing more: TIMEOUT was the
  // socket's one answer.
  verdict: (p, e) =>
    p.kind !== "unattended" || p.told
      ? [p, dropped(p, e.answer)]
      : e.awaited
        ? [{ ...p, told: true }, write(e.answer)]
        : [p, NONE],
  // [LAW:no-silent-failure] Answered with the failure whoever sent the
  // frame: a request's client, or a URL handler, which reads it as its
  // verdict. A url frame whose handler failed has no click to land, so it is
  // over once told, and told only if its socket has had no answer yet.
  failed: (p, e) => {
    switch (p.kind) {
      case "answering":
      case "held":
        return [{ kind: "answered", by: "reply" }, write(e.answer)];
      case "unattended":
        return [
          { kind: "closed", from: p },
          p.told ? dropped(p, e.answer) : write(e.answer),
        ];
      case "awaiting":
      case "answered":
      case "streaming":
      case "closed":
        return [p, dropped(p, e.answer)];
    }
  },
  landed: (p) =>
    p.kind === "unattended" ? [{ kind: "closed", from: p }, NONE] : [p, NONE],
  // A refused subscription is over: its refusal ends the stream, and a frame
  // still waiting for the socket to drain is dropped, as newest-wins drops
  // any frame a newer one replaces. The feed refuses inside the subscribe,
  // where the refusal is the request's answer, or while the stream stands,
  // having already let it go.
  refused: (p, e) => {
    switch (p.kind) {
      case "answering":
      case "held":
        return [{ kind: "answered", by: "reply" }, write(e.answer)];
      case "streaming":
        return [{ kind: "closed", from: p }, write(e.answer)];
      case "awaiting":
      case "unattended":
      case "answered":
      case "closed":
        return [p, dropped(p, e.answer)];
    }
  },
  // Only a waiting client's subscribe attaches: one the backstop answered
  // while it was on its way, or whose subscriber hung up first, is not a
  // subscription.
  subscribe: (p, e) =>
    p.kind === "answering"
      ? [
          p,
          {
            kind: "attach",
            sessionId: e.sessionId,
            lane: e.lane,
            owner: e.owner,
          },
        ]
      : [
          p,
          dropped(
            p,
            OWES_NOTHING,
            `subscribe sid=${JSON.stringify(e.sessionId)} lane=${e.lane}`,
          ),
        ],
  // The connection becomes the subscription only once it stands, so a
  // subscribe that throws stays answering, and is answered RENDER_FAILED.
  attached: (p, e) =>
    p.kind === "answering"
      ? [{ kind: "streaming", unsubscribe: e.unsubscribe }, NONE]
      : [p, { kind: "unsubscribe", unsubscribe: e.unsubscribe }],
  close: (p) => {
    switch (p.kind) {
      case "streaming":
        return [
          { kind: "closed", from: p },
          { kind: "unsubscribe", unsubscribe: p.unsubscribe },
        ];
      case "awaiting":
      case "answering":
      case "held":
      case "answered":
        return [{ kind: "closed", from: p }, NONE];
      // A url frame's writer hangs up by design: it stays in flight until its
      // click has landed.
      case "unattended":
      case "closed":
        return [p, NONE];
    }
  },
};

const step = (p: Phase, e: Event): Step =>
  (STEP[e.kind] as (p: Phase, e: Event) => Step)(p, e);

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

  // Per-request timeout protects the daemon from a single slow request
  // (e.g. a hung git call) blocking subsequent connections. It abandons the
  // RESPONSE. The handler owns what can still land: shared session context
  // and reads, a draw already sent, and clicks as their own rules admit.
  //
  // [LAW:one-source-of-truth] That is safe for the transcript-fs path because
  // the work is bounded + shared, not orphaned: the today aggregate and
  // per-session usage compute behind a SingleFlight (src/utils/single-flight.ts),
  // so a timed-out render that abandoned its await leaves behind the ONE
  // canonical in-flight scan, which the next render coalesces onto rather than
  // duplicating. A timeout therefore adds zero new fs work — there is never
  // more than one scan per key to orphan. Cancellation would be both messier
  // and wasteful here (the in-flight scan is exactly what the next tick needs).
  //
  // [LAW:no-ambient-temporal-coupling] A busy daemon runs its expired timers
  // before it reads the sockets that filled meanwhile, so the backstop answers
  // on the turn after: a frame already waiting on the socket is read first,
  // and a click in it is never answered TIMEOUT for the daemon's own delay.
  // The deferred deadline is not cancelled: in a phase that is not armed the
  // phase table moves nothing for it.
  const clearBackstop = daemon.clock.after(
    "request backstop",
    REQUEST_TIMEOUT_MS,
    () =>
      daemon.clock.defer("request backstop", () =>
        on({
          kind: "deadline",
          answer: replyOf(timeoutResponse(accepted.id)),
        }),
      ),
  );

  // [LAW:single-enforcer] The one move of the state. In flight, the backstop
  // and the timeout count are properties of the phase, so each changes
  // exactly once, as a move crosses its line.
  function on(e: Event): void {
    const [next, act] = step(phase, e);
    if (inFlight(phase) && !inFlight(next)) daemon.stats.inFlight--;
    if (armed(phase) && !armed(next)) clearBackstop();
    if (!lapsed(phase) && lapsed(next)) daemon.stats.requestsTimedOut++;
    phase = next;
    perform(act);
  }

  function perform(act: Act): void {
    switch (act.kind) {
      case "none":
        return;
      case "write":
        return send(act.answer);
      // [LAW:no-silent-failure] Said, because a daemon told to exit is
      // staying up.
      case "drop":
        daemon.log(
          act.owed.exitAfterFlush === null ? "info" : "warn",
          `${act.owed.exitAfterFlush === null ? act.what : "exit-after-flush"} dropped: ${act.why}`,
        );
        return act.owed.settled(false);
      case "attach":
        return attach(act.sessionId, act.lane, act.owner);
      case "unsubscribe":
        return act.unsubscribe();
      default: {
        const unperformed: never = act;
        throw new Error(`no act ${inspect(unperformed)}`);
      }
    }
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
  // A reply comes framed (reply.ts `replyOf`): one too big to send is already
  // its RENDER_FAILED, so a client is never left on a stream nothing answers.
  function send({ frame, unsent, exitAfterFlush, settled }: Reply): void {
    const settle =
      exitAfterFlush === null
        ? undefined
        : (): void => daemon.exit(exitAfterFlush);
    // [LAW:no-silent-failure] Said in the daemon's log as well as to the
    // client: a render's event records the failure, but no other reply
    // writes an event.
    if (unsent !== null)
      daemon.log("error", `response unsendable: ${inspect(unsent)}`);
    try {
      // [LAW:single-enforcer] Told once, on every exit, whether the client
      // took this response. A peer that already left fails the flush (it
      // ended its side), so a clean one is the client holding the response.
      sock.end(frame, (err?: Error | null) => {
        settled(unsent === null && err == null);
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

  function receivedFrame(frame: unknown): "done" {
    const inbound = classifyInbound(frame);
    on({ kind: "read", opens: opened(inbound) });
    // [LAW:single-enforcer] A handler that throws before its promise is one
    // that rejects: both are answered by the one catch below.
    new Promise<HandledRequest>((resolve) =>
      resolve(
        daemon.handle(
          inbound,
          () => lapsed(phase),
          accepted,
          () => left(phase),
        ),
      ),
    )
      .then((r) => {
        switch (r.kind) {
          case "url":
            return clicked(r);
          case "reply":
            return on({ kind: "replied", answer: r });
          case "subscribe":
            return on({
              kind: "subscribe",
              sessionId: r.sessionId,
              lane: r.lane,
              owner: r.owner,
            });
          default: {
            const unhandled: never = r;
            throw new Error(`no handling for ${inspect(unhandled)}`);
          }
        }
      })
      .catch((err: unknown) => {
        daemon.log("error", `handler threw: ${inspect(err)}`);
        on({ kind: "failed", answer: replyOf(renderFailed(err)) });
      });
    // [LAW:single-enforcer] A connection carries one frame: the reader reads
    // nothing after it.
    return "done";
  }

  function unparsed(err: Error): void {
    daemon.log("warn", `frame parse failed: ${err.message}`);
    on({
      kind: "unparsed",
      answer: replyOf({
        ok: false,
        error: err.message,
        code: "BAD_REQUEST",
        daemonV: PROTOCOL_VERSION,
      }),
    });
  }

  // A url frame's verdict, then its click, which is in flight until it lands.
  // A version 1 writer has closed, and a write to its socket is only an error
  // event.
  // [LAW:dataflow-not-control-flow] A writer that carries out the click's
  // copy and open itself is told once the click has landed, because the acts
  // are the click's output; any other is told at once.
  function clicked(r: Extract<HandledRequest, { kind: "url" }>): void {
    const tell = (answer: Response): void =>
      on({
        kind: "verdict",
        answer: replyOf(answer),
        awaited: r.awaitsVerdict,
      });
    if (!r.handsBack) tell(r.verdict);
    // [LAW:no-silent-failure] A landing that throws reaches the clock, which
    // shows it on every bar; the connection hears it landed all the same.
    daemon.clock.detach("url click landing", async () => {
      try {
        const handed = await r.land();
        if (r.handsBack) tell(withClientActs(r.verdict, handed));
      } finally {
        on({ kind: "landed" });
      }
    });
  }

  // The connection becomes the session's subscription: no reply, no request
  // timeout, and frames until the subscriber closes it.
  // [LAW:no-ambient-temporal-coupling] A subscriber slower than the frames
  // gets the newest one when its socket drains, never a backlog of stale ones.
  function attach(
    sessionId: SessionId,
    lane: Lane,
    owner: PaneOwner | null,
  ): void {
    const push = newestWins(sock);
    const unsubscribe = daemon.subscribe(sessionId, {
      lane,
      owner,
      // [LAW:no-silent-failure] A frame that cannot be pushed (past the cap)
      // is pushed as the render failure naming why. Ending the stream
      // would cause subscribers to reconnect into the same failure.
      frame: (json, settled) => {
        const { frame, unsent } = framed(
          json,
          (answer) => answer,
          JSON.stringify,
        );
        if (unsent !== null)
          daemon.log("error", `pushed frame unsendable: ${inspect(unsent)}`);
        push(frame, (written) => settled(written && unsent === null));
      },
      refused: (resp) => on({ kind: "refused", answer: replyOf(resp) }),
      drawing: () => true,
    });
    on({ kind: "attached", unsubscribe });
  }

  sock.on("data", makeFrameReader(receivedFrame, unparsed));
  sock.on("error", (err) => {
    daemon.log("warn", `socket error: ${err.message}`);
  });
  sock.on("close", () => on({ kind: "close" }));
}
