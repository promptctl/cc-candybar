import net from "node:net";
import type { Dialed, Dialer, DialFailure } from "./dialer";

// [LAW:effects-at-boundaries] The daemon's socket, through Node's `net`: the
// one client-side file that names it. A connect error becomes a DialFailure
// here, by its errno, so no caller reads a message to learn what happened.
const UNREACHABLE = new Set(["ECONNREFUSED", "ENOENT", "ENOTSOCK"]);

const failureOf = (err: NodeJS.ErrnoException): DialFailure => ({
  cause: UNREACHABLE.has(err.code ?? "") ? "unreachable" : "io_error",
  message: err.message,
});

export const systemDialer: Dialer = {
  dial(sockPath) {
    const sock = net.createConnection({ path: sockPath });
    let settledYet = false;
    const settled = new Promise<Dialed>((resolve) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        sock.off("connect", onConnect);
        settledYet = true;
        resolve({ ok: false, failure: failureOf(err) });
      };
      const onConnect = (): void => {
        sock.off("error", onError);
        settledYet = true;
        resolve({ ok: true, conn: sock });
      };
      sock.once("error", onError);
      sock.once("connect", onConnect);
    });
    return {
      settled,
      abandon: () => {
        if (settledYet) return;
        // A destroyed connect raises neither event, so `settled` stays pending.
        sock.removeAllListeners();
        sock.destroy();
      },
    };
  },
};
