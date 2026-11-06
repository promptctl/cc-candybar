// [LAW:single-enforcer] [LAW:effects-at-boundaries] A client's side of the
// daemon's socket: dialing the path a home's daemon listens on, and the
// connection that answers. src/dial/system-dialer.ts is the adapter over a unix
// socket; src/dial/dialer-fake.ts is the in-memory one tests listen on; the
// contract both pass is test/contract/dialer.contract.ts.
//
// The port has no budget. A caller bounds a dial on the clock it is handed and
// abandons it when that runs out, so every timer stays on a Timekeeper.

import type { Duplex } from "node:stream";
import type { TimerOptions, Timekeeper } from "../time.js";

// [LAW:parse-dont-validate] Why a dial found no daemon, decided at the edge.
// `unreachable`: nothing listens there (no socket file, a file that is not a
// socket, a socket nobody has bound), so a fresh daemon may cure it.
// `io_error`: any other failure to connect.
export interface DialFailure {
  readonly cause: "unreachable" | "io_error";
  readonly message: string;
}

export type Dialed =
  | { readonly ok: true; readonly conn: Duplex }
  | { readonly ok: false; readonly failure: DialFailure };

// A dial under way. `settled` resolves once, never rejects, and never on the
// turn of the dial. `abandon` gives the dial up before it settles: the
// connection is closed and `settled` stays pending. Once settled, it does
// nothing, and the connection is the caller's to close.
export interface Dialing {
  readonly settled: Promise<Dialed>;
  abandon(): void;
}

export interface Dialer {
  dial(sockPath: string): Dialing;
}

// A dial bounded by a budget: the connection, why there is none, or the budget
// running out first, which abandons the dial.
export type BoundedDial =
  | Dialed
  | {
      readonly ok: false;
      readonly failure: { readonly cause: "timeout" };
    };

// [LAW:single-enforcer] The one bound on a dial, on the clock the caller holds.
export function dialWithin(
  dialer: Dialer,
  sockPath: string,
  budgetMs: number,
  clock: Pick<Timekeeper, "after">,
  options?: TimerOptions,
): Promise<BoundedDial> {
  const dialing = dialer.dial(sockPath);
  return new Promise((resolve) => {
    const clearTimer = clock.after(
      budgetMs,
      () => {
        dialing.abandon();
        resolve({ ok: false, failure: { cause: "timeout" } });
      },
      options,
    );
    void dialing.settled.then((dialed) => {
      clearTimer();
      resolve(dialed);
    });
  });
}
