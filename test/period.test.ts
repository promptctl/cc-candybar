import { Period } from "../src/utils/period";

afterEach(() => {
  jest.useRealTimers();
});

describe("Period", () => {
  test("a disposed period never runs again, whatever holds or lands after", async () => {
    jest.useFakeTimers();
    let ticks = 0;
    const period = new Period(() => ticks++);
    period.landed(1_000);
    period.hold(true);
    period.dispose();

    period.hold(false);
    period.hold(true);
    period.landed(1_000);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(ticks).toBe(0);
  });

  test("a landing kept from earlier resumes where it left off", async () => {
    jest.useFakeTimers();
    let ticks = 0;
    const period = new Period(() => ticks++);
    period.hold(true);

    period.landed(1_000, Date.now() - 600);
    await jest.advanceTimersByTimeAsync(399);
    expect(ticks).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(ticks).toBe(1);

    period.landed(1_000, Date.now() - 5_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(ticks).toBe(2);
    period.dispose();
  });
});
