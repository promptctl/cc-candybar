import { duplexPair, type Duplex } from "node:stream";
import type { Timekeeper } from "../time.js";
import type { Dialed, Dialer } from "./dialer.js";

// [LAW:one-source-of-truth] Socket paths held in memory, each either listened
// on or held bound with no one accepting. Imported only by tests; it passes the
// same contract as the socket (test/contract/dialer.contract.ts).
//
// [LAW:effects-at-boundaries] A dial settles through the injected clock's
// `defer`, never on the turn of the dial, as a socket's connect does.

// What a listener on the fake's path is handed: the daemon's end of a
// connection.
export type OnConnection = (daemonEnd: Duplex) => void;

export interface DialerFake extends Dialer {
  // Accepts every dial of `sockPath` until the returned stop.
  listen(sockPath: string, onConnection: OnConnection): () => void;
  // Binds `sockPath` and never accepts: a dial neither connects nor fails.
  hold(sockPath: string): () => void;
  // How many dials of `sockPath` there have been.
  dials(sockPath: string): number;
  // How many connections are still open: a close at either end closes both.
  open(): number;
}

// A connection's two ends in memory. A bare pair carries a half-close but not
// a hang-up: a destroyed side says nothing to the other, whose `end` callback
// then never settles, where a socket's vanished peer settles it with an error.
// So each end's close destroys the other, and a client's `destroy` is a
// hang-up. The client closes on the daemon's end as a socket from
// `net.connect` does; the daemon's side is left as the pair builds it, so what
// it does at a half-close is the connection's.
export function memoryConnection(): { daemonEnd: Duplex; client: Duplex } {
  const [daemonEnd, client] = duplexPair();
  client.allowHalfOpen = false;
  daemonEnd.once("close", () => client.destroy());
  client.once("close", () => daemonEnd.destroy());
  return { daemonEnd, client };
}

type Bound =
  | { readonly kind: "listening"; readonly onConnection: OnConnection }
  | { readonly kind: "held" };

export function dialerFake(clock: Pick<Timekeeper, "defer">): DialerFake {
  const bound = new Map<string, Bound>();
  const dialCounts = new Map<string, number>();
  const live = new Set<Duplex>();

  const bind = (sockPath: string, entry: Bound): (() => void) => {
    if (bound.has(sockPath)) {
      throw new Error(`listen EADDRINUSE: address already in use ${sockPath}`);
    }
    bound.set(sockPath, entry);
    return () => {
      if (bound.get(sockPath) === entry) bound.delete(sockPath);
    };
  };

  return {
    listen: (sockPath, onConnection) =>
      bind(sockPath, { kind: "listening", onConnection }),
    hold: (sockPath) => bind(sockPath, { kind: "held" }),
    dials: (sockPath) => dialCounts.get(sockPath) ?? 0,
    open: () => live.size,
    dial(sockPath) {
      dialCounts.set(sockPath, (dialCounts.get(sockPath) ?? 0) + 1);
      let settledYet = false;
      let resolve!: (dialed: Dialed) => void;
      const settled = new Promise<Dialed>((r) => (resolve = r));
      const settle = (dialed: Dialed): void => {
        settledYet = true;
        resolve(dialed);
      };
      // [LAW:dataflow-not-control-flow] What a dial meets is read when it
      // lands, as a kernel reads the path at connect.
      const cancel = clock.defer(() => {
        const at = bound.get(sockPath);
        if (at === undefined) {
          settle({
            ok: false,
            failure: {
              cause: "unreachable",
              message: `connect ENOENT ${sockPath}`,
            },
          });
        } else if (at.kind === "listening") {
          const { daemonEnd, client } = memoryConnection();
          live.add(client);
          client.once("close", () => live.delete(client));
          // Settled first, so a listener that throws fails loudly here
          // rather than leaving the dial pending.
          settle({ ok: true, conn: client });
          at.onConnection(daemonEnd);
        }
      });
      return {
        settled,
        abandon: () => {
          if (!settledYet) cancel();
        },
      };
    },
  };
}
