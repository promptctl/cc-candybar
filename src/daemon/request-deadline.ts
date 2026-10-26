// When a statusline request's wait ends (brandon-unfiled-3248.8ro6, §4c).
//
// Only the client knows when it will hang up: the native client counts its
// budget from before it connects, the Node client from after, and the daemon
// reads a request late by an unknown amount under load. So the client states
// it, as `deadline` on the request, and the wait ends early enough for the
// draw to fit before it. A value still not answered then draws as pending.

import { CONNECT_TIMEOUT_MS, TOTAL_BUDGET_MS } from "./client";

// [LAW:single-enforcer] Every handler's backstop: the connection's own timer
// answers TIMEOUT at this, whatever its request is still doing.
export const REQUEST_TIMEOUT_MS = 200;

// What a request's wait leaves for its draw: the synchronous turn that reads
// the view and turns it into the answer's bytes. Held to at p99 by
// test/draw-reserve.test.ts, over a view's cold first draw of the bundled
// default and of the load gate's full config. Measured 2026-10-26: p99 3-5 ms
// idle, 8 ms beside a parallel test run. The rest is room for a user config
// whose effect draws several times that (a maintainer's config, effect on,
// drew 42 ms at p90): a reserve too small answers after its client has hung
// up, and the bar goes blank, where one too large only draws more pending.
export const DRAW_RESERVE_MS = 40;

// [LAW:parse-dont-validate] When the client hangs up, as the checkpoint
// parsed it: the epoch milliseconds it stated, or nothing, from a client too
// old to state one (and from the demo, which has no client).
export type ClientDeadline =
  | { readonly kind: "stated"; readonly at: number }
  | { readonly kind: "unstated" };

// The request's arrival on both clocks: the wall clock a stated deadline is
// spelled in, and the monotonic one the connection's timer runs on.
export interface Arrival {
  readonly epochMs: number;
  readonly monoMs: number;
}

// [LAW:one-source-of-truth] The milliseconds a request's wait has from its
// arrival: until its client hangs up or the connection's backstop answers,
// whichever is first, less the draw's reserve. A client that states no
// deadline is taken to hang up when the Node client does, its budget after a
// connect that took all its time. Below zero is no wait at all.
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
