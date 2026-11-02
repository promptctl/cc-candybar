// When a statusline request's wait ends (brandon-unfiled-3248.8ro6, §4c).
//
// Only the client knows when it will hang up: the native client counts its
// budget from before it connects, the Node client from after, and the daemon
// reads a request late by an unknown amount under load. So the client states
// it, as `deadline` on the request, and the wait ends early enough for the
// draw to fit before it. A value still not answered then draws as pending.

import { CONNECT_TIMEOUT_MS, TOTAL_BUDGET_MS, type Request } from "./protocol";

// [LAW:single-enforcer] Every handler's backstop: the connection's own timer
// answers TIMEOUT at this, whatever its request is still doing.
export const REQUEST_TIMEOUT_MS = 200;

// How long a program a click launches has before the click fails: a handful of
// seconds at most for a clipboard or an opener, each of which hands off and exits.
export const CLICK_PROGRAM_TIMEOUT_MS = 5000;

// A click's backstop. A click is not on the statusline's clock: nothing draws
// while it runs, and its handler awaits the program it launches, so its bound
// covers that launch plus a turn's wait. Held to the render's bound, a click
// that launches anything is answered TIMEOUT while its effect still lands, and
// its client kicks a daemon that was never down.
export const CLICK_TIMEOUT_MS = CLICK_PROGRAM_TIMEOUT_MS + 1000;

// [LAW:dataflow-not-control-flow] The connection's backstop for a request, by
// its kind. Before the frame is read the kind is unknown and the request's
// own bound applies.
export function requestTimeoutMs(kind: Request["kind"] | undefined): number {
  return kind === "click" ? CLICK_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

// What a request's wait leaves for its draw: the synchronous turn that reads
// the view and turns it into the answer's bytes. Held to at p99 by
// test/draw-reserve.process.test.ts, over a view's cold first draw of the bundled
// default and of the load gate's full config. A cold draw takes a few ms on an
// idle machine, but the reserve is wall time, and a draw descheduled on a busy
// one reads tens of ms with no more work in it: CI's runner, its cores shared
// with the other process-tier suites, reads up to 48 ms. A user config whose
// effect draws several times the idle figure (a maintainer's config, effect
// on, drew 42 ms at p90) is not measured here, and on a busy machine it can
// still outrun the reserve. A reserve too small answers after its client has
// hung up, and the bar goes blank, where one too large only draws more pending.
export const DRAW_RESERVE_MS = 60;

// [LAW:parse-dont-validate] When the client hangs up, as the checkpoint
// parsed it: the epoch milliseconds it stated, or nothing, from a client too
// old to state one (and from the demo, which has no client).
export type ClientDeadline =
  | { readonly kind: "stated"; readonly at: number }
  | { readonly kind: "unstated" };

// The request's `deadline` field, parsed: a client too old to state one sends
// none, and anything but epoch milliseconds is refused, never read as "no
// deadline" — a broken client's wait would silently become the old client's.
export function parseClientDeadline(
  raw: unknown,
): ClientDeadline | { readonly kind: "refused"; readonly problem: string } {
  if (raw === undefined) return { kind: "unstated" };
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
    ? { kind: "stated", at: raw }
    : {
        kind: "refused",
        problem: `request 'deadline' is not epoch milliseconds: ${JSON.stringify(raw)}`,
      };
}

// The request's arrival on both clocks: the wall clock a stated deadline is
// spelled in, and the monotonic one the connection's timer runs on.
export interface Arrival {
  readonly epochMs: number;
  readonly monoMs: number;
}

// [LAW:one-source-of-truth] The milliseconds a request's wait has from its
// arrival: until its client hangs up or the connection's backstop answers,
// whichever is first, less the draw's reserve. A client that states no
// deadline is taken to hang up at the earliest an old client can: the native
// client's, whose budget runs from before a connect that took all its time.
// Below zero is no wait at all.
export function waitBudgetMs(
  deadline: ClientDeadline,
  acceptedMonoMs: number,
  arrival: Arrival,
): number {
  const clientEnd =
    deadline.kind === "stated"
      ? arrival.monoMs + (deadline.at - arrival.epochMs)
      : acceptedMonoMs + TOTAL_BUDGET_MS - CONNECT_TIMEOUT_MS;
  const end = Math.min(clientEnd, acceptedMonoMs + REQUEST_TIMEOUT_MS);
  return Math.round(end - DRAW_RESERVE_MS - arrival.monoMs);
}
