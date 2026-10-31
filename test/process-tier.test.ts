import {
  judgeDaemonStarts,
  parseLedger,
  withDaemonLedger,
} from "./helpers/process-tier.cjs";

const TIER = "test/daemon-shutdown.process.test.ts";
const OUTSIDE = "test/daemon-effect-e2e.test.ts";
type Route = "helper" | "client" | "raw";

const start = (file: string | null, route: Route) => ({ file, route });
const judged = (...starts: ReturnType<typeof start>[]) =>
  judgeDaemonStarts(starts, 2);

describe("judgeDaemonStarts", () => {
  test("an empty ledger is a clean verdict that counts zero", () => {
    expect(judged()).toEqual({ helper: 0, client: 0, problems: [] });
  });

  test("the tier may start daemons, up to the ceiling", () => {
    expect(judged(start(TIER, "helper"), start(TIER, "helper"))).toEqual({
      helper: 2,
      client: 0,
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

  test("a start naming no test file is outside the tier", () => {
    expect(judged(start(null, "raw")).problems).toEqual([
      expect.stringContaining("carries no test file"),
    ]);
  });

  test("a client's start in the tier is counted apart, and the ceiling ignores it", () => {
    const verdict = judged(
      start(TIER, "helper"),
      start(TIER, "helper"),
      start(TIER, "client"),
      start(TIER, "client"),
    );
    expect(verdict).toEqual({ helper: 2, client: 2, problems: [] });
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

test("withDaemonLedger keeps what NODE_OPTIONS already held", () => {
  expect(withDaemonLedger("--trace-warnings")).toMatch(
    /^--trace-warnings --import=file:.*daemon-ledger\.cjs$/,
  );
  expect(withDaemonLedger(undefined)).toMatch(/^--import=file:/);
});
