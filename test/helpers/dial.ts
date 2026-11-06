import { dialerFake, type DialerFake } from "../../src/dial/dialer-fake";
import type { Timekeeper } from "../../src/time";

// A clock whose deferred runs land on the next microtask, so a case can await
// a dial without advancing anything, and a held clock keeps every timer.
export const nextMicrotask: Pick<Timekeeper, "defer"> = {
  defer: (fire) => {
    let live = true;
    queueMicrotask(() => live && fire());
    return () => (live = false);
  },
};

// The fake dialer a test listens on when no clock decides when a dial lands.
export const fakeDialer = (): DialerFake => dialerFake(nextMicrotask);
