import { sleep, timeoutSignal, type Timekeeper } from "../../src/time";

// What a test of a Timekeeper moves time with: the held clock advances by hand,
// the real one waits. Each case ends by calling it, so the same assertions run
// on both.
export interface Subject {
  readonly clock: Timekeeper;
  readonly settle: (ms: number) => Promise<void>;
}

// [LAW:one-source-of-truth] What a Timekeeper promises, stated once. The held
// clock (test/unit/held-clock.test.ts) and the real one
// (test/integration/system-timekeeper.test.ts) both run it, so a case that
// passes on the fake passes on the machine: the fake has earned the trust a
// unit test puts in it. Real time forbids exact figures, so a case asserts an
// order or a lower bound, never a duration.
export function timekeeperContract(
  name: string,
  make: () => Subject,
): void {
  describe(`${name} is a Timekeeper`, () => {
    test("timers run in the order of their delays", async () => {
      const { clock, settle } = make();
      const ran: string[] = [];
      clock.after(60, () => ran.push("late"));
      clock.after(20, () => ran.push("early"));
      await settle(150);
      expect(ran).toEqual(["early", "late"]);
    });

    test("a timer runs once, and not on the turn that set it", async () => {
      const { clock, settle } = make();
      let runs = 0;
      clock.after(0, () => runs++);
      expect(runs).toBe(0);
      await settle(150);
      expect(runs).toBe(1);
    });

    test("a cleared timer never runs", async () => {
      const { clock, settle } = make();
      let runs = 0;
      const clear = clock.after(20, () => runs++);
      clear();
      await settle(150);
      expect(runs).toBe(0);
    });

    test("a timer cleared by an earlier one does not run", async () => {
      const { clock, settle } = make();
      const ran: string[] = [];
      const clearLater = clock.after(60, () => ran.push("later"));
      clock.after(20, () => {
        ran.push("earlier");
        clearLater();
      });
      await settle(150);
      expect(ran).toEqual(["earlier"]);
    });

    test("a repeating timer runs again and again until cleared", async () => {
      const { clock, settle } = make();
      let runs = 0;
      const clear = clock.every(20, () => runs++);
      await settle(110);
      expect(runs).toBeGreaterThanOrEqual(2);
      clear();
      const seen = runs;
      await settle(110);
      expect(runs).toBe(seen);
    });

    test("a repeating timer can clear itself from inside its run", async () => {
      const { clock, settle } = make();
      let runs = 0;
      const clear = clock.every(20, () => {
        runs++;
        clear();
      });
      await settle(150);
      expect(runs).toBe(1);
    });

    test("a deferred run waits for the work now running, and runs once", async () => {
      const { clock, settle } = make();
      let runs = 0;
      clock.defer(() => runs++);
      expect(runs).toBe(0);
      await settle(0);
      await settle(20);
      expect(runs).toBe(1);
    });

    test("a cleared deferral never runs", async () => {
      const { clock, settle } = make();
      let runs = 0;
      const clear = clock.defer(() => runs++);
      clear();
      await settle(20);
      expect(runs).toBe(0);
    });

    test("the monotonic reading only moves forward, by at least about what was waited", async () => {
      const { clock, settle } = make();
      const before = clock.monotonic();
      await settle(100);
      expect(clock.monotonic() - before).toBeGreaterThanOrEqual(50);
    });

    test("the wall reading moves with the monotonic one", async () => {
      const { clock, settle } = make();
      const before = clock.now();
      await settle(100);
      expect(clock.now() - before).toBeGreaterThanOrEqual(50);
    });

    test("sleep resolves once its time has passed", async () => {
      const { clock, settle } = make();
      let slept = false;
      void sleep(clock, 20).then(() => (slept = true));
      await settle(150);
      expect(slept).toBe(true);
    });

    test("a signal aborts a sleep with an AbortError carrying the signal's reason", async () => {
      const { clock, settle } = make();
      const stop = new AbortController();
      const reason = new Error("closing");
      const outcome = sleep(clock, 60_000, stop.signal).then(
        () => "slept",
        (e: unknown) => e,
      );
      stop.abort(reason);
      await settle(0);
      const rejected = (await outcome) as Error & { cause?: unknown };
      expect(rejected.name).toBe("AbortError");
      expect(rejected.cause).toBe(reason);
    });

    test("a signal that is already aborted rejects a sleep at once", async () => {
      const { clock } = make();
      const stop = new AbortController();
      stop.abort();
      await expect(sleep(clock, 20, stop.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
    });

    test("a timeout signal aborts with a TimeoutError once its time has passed", async () => {
      const { clock, settle } = make();
      const signal = timeoutSignal(clock, 20);
      expect(signal.aborted).toBe(false);
      await settle(150);
      expect(signal.aborted).toBe(true);
      expect((signal.reason as Error).name).toBe("TimeoutError");
    });
  });
}
