import { dialerFake } from "../../src/dial/dialer-fake";
import { heldClock } from "../../src/held-clock";
import { dialerContract } from "../contract/dialer.contract";
import { nextMicrotask as soon } from "../helpers/dial";

let n = 0;
dialerContract("the fake dialer", () => {
  const dialer = dialerFake(soon);
  return {
    dialer,
    path: () => `/fake/s${n++}.sock`,
    listen: async (sockPath, onConnection) => {
      const stop = dialer.listen(sockPath, onConnection);
      return async () => stop();
    },
  };
});

describe("the fake dialer", () => {
  test("a dial lands when the clock runs it, not on its own turn", async () => {
    const clock = heldClock(new Date(0));
    const dialer = dialerFake(clock);
    dialer.listen("/a", (end) => end.resume());
    let landed = false;
    void dialer.dial("/a").settled.then(() => (landed = true));
    await Promise.resolve();
    expect(landed).toBe(false);
    clock.advance(0);
    await Promise.resolve();
    expect(landed).toBe(true);
    expect(dialer.open()).toBe(1);
  });

  test("a held path takes the dial and never answers", async () => {
    const clock = heldClock(new Date(0));
    const dialer = dialerFake(clock);
    dialer.hold("/held");
    let landed = false;
    void dialer.dial("/held").settled.then(() => (landed = true));
    clock.advance(1_000);
    await Promise.resolve();
    expect(landed).toBe(false);
    expect(dialer.dials("/held")).toBe(1);
  });

  test("a closed connection is no longer open, from either end", async () => {
    const dialer = dialerFake(soon);
    dialer.listen("/a", (end) => end.destroy());
    const dialed = await dialer.dial("/a").settled;
    if (!dialed.ok) throw new Error(dialed.failure.message);
    await new Promise((r) => dialed.conn.once("close", r));
    expect(dialer.open()).toBe(0);
  });

  test("a second listener on a bound path is refused", () => {
    const dialer = dialerFake(soon);
    dialer.listen("/a", () => {});
    expect(() => dialer.hold("/a")).toThrow(/EADDRINUSE/);
  });
});
