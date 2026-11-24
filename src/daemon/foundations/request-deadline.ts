// When a statusline request's wait ends (brandon-unfiled-3248.8ro6, §4c).
//
// Only the client knows when it will hang up: the native client counts its
// budget from before it connects, the Node client from after, and the daemon
// reads a request late by an unknown amount under load. So the client states
// it, as `deadline` on the request, and the wait ends early enough for the
// draw to fit before it. A value still not answered then draws as pending.

import type { RequestId } from "../../renderer-interface/interface.js";
import {
  CONNECT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SESSION_RENDER_KIND,
  TOTAL_BUDGET_MS,
  type Refusal,
  type Request,
} from "./protocol";

// [LAW:single-enforcer] The one backstop: the connection's own timer answers
// TIMEOUT at this, whatever its request is still doing. A frame not yet read is
// always bounded by it, and one read is bounded for the kinds
// `BACKSTOP_BOUNDS_READ` names.
export const REQUEST_TIMEOUT_MS = 200;

// [LAW:types-are-the-program] Whether the backstop still answers for a request
// once its frame is read, by kind: the compiler names a kind added to the
// protocol until it says. A click the daemon has read is answered with its own
// outcome however long its turn takes, so a TIMEOUT to a click means no frame
// of it had reached the daemon when the backstop fired: its action did not
// run, and it can be sent again (src/daemon/reply.ts). A render's TIMEOUT stays
// bounded, since the statusline client relies on it for a draw that is slow.
export const BACKSTOP_BOUNDS_READ: Readonly<Record<Request["kind"], boolean>> =
  {
    render: true,
    [SESSION_RENDER_KIND]: true,
    subscribe: true,
    "pane-session": true,
    shutdown: true,
    stats: true,
    click: false,
    recording: true,
    debug: true,
  };

// [LAW:parse-dont-validate] The kind is untrusted JSON: one no request carries
// is refused at once, so the backstop still bounds it.
export const backstopBoundsRead = (kind: unknown): boolean =>
  typeof kind !== "string" ||
  !Object.hasOwn(BACKSTOP_BOUNDS_READ, kind) ||
  BACKSTOP_BOUNDS_READ[kind as Request["kind"]];

// [LAW:single-enforcer] The timeout sent by the connection backstop or by
// the render that learned its reply cannot arrive within its own deadline.
export const timeoutResponse = (
  request: RequestId,
  error = `request exceeded ${REQUEST_TIMEOUT_MS}ms`,
): Refusal => ({
  ok: false,
  error,
  code: "TIMEOUT",
  daemonV: PROTOCOL_VERSION,
  request,
});

// What a request's wait leaves for its draw: the synchronous turn that reads
// the view and turns it into the answer's bytes. Held to at p99 by
// test/daemon-boots/process/draw-reserve.test.ts, over a view's cold first draw of the bundled
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
// old to state one.
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

// [LAW:one-source-of-truth] Translate a client's explicit deadline to the
// host clock. The source wait leaves the draw's reserve. The earlier budget
// estimate for old clients limits the wait and gives no evidence the client
// left. The connection owns its backstop.
export function renderDeadlines(
  deadline: ClientDeadline,
  acceptedMonoMs: number,
  arrival: Arrival,
): { readonly waitEndsAt: number; readonly clientEndsAt: number | null } {
  const clientEndsAt =
    deadline.kind === "stated"
      ? arrival.monoMs + (deadline.at - arrival.epochMs)
      : null;
  const sourceEnd = Math.min(
    acceptedMonoMs + REQUEST_TIMEOUT_MS,
    clientEndsAt ?? acceptedMonoMs + TOTAL_BUDGET_MS - CONNECT_TIMEOUT_MS,
  );
  const waitEndsAt =
    arrival.monoMs + Math.round(sourceEnd - DRAW_RESERVE_MS - arrival.monoMs);
  return { waitEndsAt, clientEndsAt };
}
