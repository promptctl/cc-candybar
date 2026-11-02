import {
  judgeDaemonStarts,
  parseLedger,
} from "../helpers/process-tier.cjs";

const TIER = "test/daemon-boots/process/daemon-shutdown.test.ts";
const WORKER_TIER = "test/daemon-boots/worker/daemon-value.test.ts";
const OUTSIDE = "test/daemon-effect-e2e.test.ts";
type Route = "helper" | "client" | "raw" | "harness";

const start = (file: string | null, route: Route) => ({ file, route });
const judged = (...starts: ReturnType<typeof start>[]) =>
  judgeDaemonStarts(starts, 2);

describe("judgeDaemonStarts", () => {
  test("an empty ledger is a clean verdict that counts zero", () => {
    expect(judged()).toEqual({ helper: 0, client: 0, harness: 0, problems: [] });
  });

  test("the tier may start daemons, up to the ceiling", () => {
    expect(judged(start(TIER, "helper"), start(TIER, "helper"))).toEqual({
      helper: 2,
      client: 0,
      harness: 0,
      problems: [],
    });
  });

  test("a helper start over the ceiling is named with the count", () => {
    const { problems } = judged(
      start(TIER, "helper"),
      start(TIER, "helper"),
      start(TIER, "helper"),
    );
    expect(problems).toEqual([expect.stringContaining("3 helper daemon starts, over the ceiling of 2")]);
  });

  test("a start outside the tier is named by its file, whatever its route", () => {
    for (const route of ["helper", "client", "raw"] as const) {
      expect(judged(start(OUTSIDE, route)).problems).toEqual([
        expect.stringContaining(`${OUTSIDE} started a real daemon (${route})`),
      ]);
    }
  });

  test("a daemon built in a worker is allowed under test/daemon-boots/ and counted apart from the ceiling", () => {
    const harness = (file: string) => start(file, "harness");
    expect(judged(harness(WORKER_TIER), harness(WORKER_TIER), harness(WORKER_TIER), harness(TIER))).toEqual({
      helper: 0,
      client: 0,
      harness: 4,
      problems: [],
    });
  });

  test("a daemon built in a worker by any other file is named by that file", () => {
    expect(judged(start(OUTSIDE, "harness")).problems).toEqual([
      expect.stringContaining(`${OUTSIDE} booted a daemon in the jest worker`),
    ]);
    // A unit file and a file at the test/ root are the files a moved case lands in.
    expect(judged(start("test/unit/moved.test.ts", "harness")).problems).toHaveLength(1);
  });

  test("an over-ceiling message offers no raise", () => {
    const { problems } = judged(start(TIER, "helper"), start(TIER, "helper"), start(TIER, "helper"));
    expect(problems[0]).not.toMatch(/raise/);
  });

  test("a start naming no test file is outside the tier", () => {
    expect(judged(start(null, "raw")).problems).toEqual([
      expect.stringContaining("recorded with no test file"),
    ]);
  });

  test("a client's start in the tier is counted apart, and the ceiling ignores it", () => {
    const verdict = judged(
      start(TIER, "helper"),
      start(TIER, "helper"),
      start(TIER, "client"),
      start(TIER, "client"),
    );
    expect(verdict).toEqual({ helper: 2, client: 2, harness: 0, problems: [] });
  });

  test("a raw start is refused in the tier too", () => {
    expect(judged(start(TIER, "raw")).problems).toEqual([
      expect.stringContaining(`${TIER} started a daemon by a spawn of its own`),
    ]);
  });

  test("a file's repeated fault is reported once", () => {
    expect(judged(start(OUTSIDE, "helper"), start(OUTSIDE, "helper")).problems).toHaveLength(1);
  });
});

test("parseLedger reads one start per line", () => {
  expect(parseLedger(`{"file":"a","route":"helper"}\n{"file":null,"route":"raw"}\n`)).toEqual([
    start("a", "helper"),
    start(null, "raw"),
  ]);
});
