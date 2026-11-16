import { RefreshFaults } from "../src/daemon/refresh-faults";
import {
  TranscriptLanes,
  TRANSCRIPT_PERIOD,
  type Followed,
  type LaneOwners,
} from "../src/daemon/cache/transcript-lanes";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { REFRESH_LANES } from "../src/facts/world-state";
import { Holds } from "../src/utils/holds";
import { ABSENT, failed } from "../src/utils/outcome";
import { RefreshLedger } from "../src/utils/refresh-ledger";
import type { WatcherRegistry } from "../src/daemon/cache/watchers";
import { heldClock } from "./helpers/held-clock";

// [LAW:behavior-not-structure] The trigger of a session's transcript lanes,
// through what its owners are asked and when: a session's first declaration
// reads every lane, a write the watch hears reads them again, the backstop
// period reads them while a session holds them, and a request's declaration
// over a landed entry reads nothing.

const SESSION = sessionIdOf("lanes-test");
const FOLLOWED: Followed = {
  session: SESSION,
  transcript: "/home/t/.claude/projects/p/lanes-test.jsonl",
  settings: "/home/t/.claude/settings.json",
};

function rig({ throwing = new Set<string>() } = {}) {
  const clock = heldClock(new Date(1_700_000_000_000));
  // Each owner's call, by the trigger it was read under.
  const calls: string[] = [];
  const call = (lane: string, by: string) => {
    calls.push(`${lane}:${by}`);
    if (throwing.has(lane)) throw new Error(`${lane} bug`);
    return Promise.resolve(ABSENT);
  };
  const owners: LaneOwners = {
    usageStore: {
      refresh: (_s, _t, by) => {
        calls.push(`ingest:${by}`);
        return {
          usage: () => call("session", by),
          speed: () => call("speed", by),
        };
      },
    },
    contextProvider: { refresh: (_s, _t, by) => call("context", by) },
    metricsProvider: { refresh: (_s, _t, by) => call("metrics", by) },
    activityProvider: { refresh: (_s, _t, by) => call("activity", by) },
    cacheExpiry: { refresh: (_s, _t, by) => call("cache", by) },
    autoCompact: {
      window: (_p, by) => {
        calls.push(`autocompact:${by}`);
        if (throwing.has("autocompact")) throw new Error("autocompact bug");
        return ABSENT;
      },
    },
    faults: new RefreshFaults(),
  };
  // The watch the entry acquired, fired by hand.
  const watched: Array<{
    targets: Parameters<WatcherRegistry["acquire"]>[1];
    changed: () => void;
  }> = [];
  const logged: string[] = [];
  const lanes = new TranscriptLanes({
    owners,
    watchers: {
      acquire: (_key, targets, changed) => {
        watched.push({ targets, changed: () => changed({} as never) });
        return { release: () => {}, deaf: [] };
      },
    },
    clock,
    logger: (level, msg) => logged.push(`${level} ${msg}`),
    ledger: new RefreshLedger((level, msg) => logged.push(`${level} ${msg}`)),
  });
  return { clock, calls, owners, watched, logged, lanes };
}

// What one read of every lane asks its owners, under `by`.
const readAll = (by: string) => [
  `ingest:${by}`,
  ...REFRESH_LANES.map((lane) => `${lane}:${by}`),
];

let close: Array<() => void> = [];
afterEach(() => {
  for (const c of close) c();
  close = [];
});

test("a session's first declaration reads every lane once, and answers pending until the read lands", async () => {
  const { clock, calls, lanes } = rig();
  close.push(() => lanes.close());
  const holds = new Holds();
  const lane = holds.declare(() => lanes.declare(holds, FOLLOWED)).result;
  expect(lane.current()).toMatchObject({ kind: "pending", why: "unread" });
  await clock.settle(0);
  expect(lane.current()).toEqual({ kind: "ok", value: null });
  expect(calls.sort()).toEqual(readAll("first").sort());
});

test("a request's declaration over a landed entry reads nothing", async () => {
  const { clock, calls, lanes } = rig();
  close.push(() => lanes.close());
  const holds = new Holds();
  holds.declare(() => lanes.declare(holds, FOLLOWED));
  await clock.settle(0);
  calls.length = 0;
  const again = holds.declare(() => lanes.declare(holds, FOLLOWED));
  await clock.settle(0);
  expect(again.result.current()).toEqual({ kind: "ok", value: null });
  expect(calls).toEqual([]);
});

test("the watch hears the transcript and the settings file by name, and a write it hears reads every lane again", async () => {
  const { clock, calls, watched, lanes } = rig();
  close.push(() => lanes.close());
  const holds = new Holds();
  holds.declare(() => lanes.declare(holds, FOLLOWED));
  await clock.settle(0);
  expect(watched.map((w) => w.targets.dirs)).toEqual([
    [
      {
        path: "/home/t/.claude/projects/p",
        filenames: ["lanes-test.jsonl"],
      },
      { path: "/home/t/.claude", filenames: ["settings.json"] },
    ],
  ]);
  calls.length = 0;
  watched[0]!.changed();
  await clock.settle(0);
  expect(calls.sort()).toEqual(readAll("change").sort());
});

test("with no event heard, the period reads every lane again while a session holds them, and not after", async () => {
  const { clock, calls, lanes } = rig();
  close.push(() => lanes.close());
  const holds = new Holds();
  holds.declare(() => lanes.declare(holds, FOLLOWED));
  await clock.settle(0);
  calls.length = 0;
  await clock.settle(TRANSCRIPT_PERIOD.okMs);
  expect(calls.sort()).toEqual(readAll("period").sort());
  calls.length = 0;
  holds.close();
  await clock.settle(TRANSCRIPT_PERIOD.okMs * 3);
  expect(calls).toEqual([]);
});

// [LAW:nothing-unseen] A session held for hours adds nothing to the log while
// its transcript is quiet; each write its watch hears is one line.
test("a quiet session's period writes no line, and a write's read writes one", async () => {
  const { clock, watched, logged, lanes } = rig();
  close.push(() => lanes.close());
  const holds = new Holds();
  holds.declare(() => lanes.declare(holds, FOLLOWED));
  await clock.settle(0);
  const refreshLines = () =>
    logged.filter((l) => l.startsWith("info transcript refresh"));
  expect(refreshLines()).toEqual([expect.stringMatching(/ by=first /)]);
  await clock.settle(TRANSCRIPT_PERIOD.okMs * 3);
  expect(refreshLines()).toHaveLength(1);
  watched[0]!.changed();
  await clock.settle(0);
  expect(refreshLines()).toEqual([
    expect.stringMatching(/ by=first /),
    expect.stringMatching(/ by=change /),
  ]);
});

test("a lane whose read throws is logged and kept as that lane's failure; the rest read, and a clean read clears it", async () => {
  const throwing = new Set(["metrics", "autocompact"]);
  const { clock, calls, owners, watched, logged, lanes } = rig({ throwing });
  close.push(() => lanes.close());
  const holds = new Holds();
  const lane = holds.declare(() => lanes.declare(holds, FOLLOWED)).result;
  await clock.settle(0);
  expect(lane.current()).toEqual({ kind: "ok", value: null });
  expect(calls.sort()).toEqual(readAll("first").sort());
  expect(owners.faults.of(SESSION, "metrics")).toEqual(
    failed("metrics: Error: metrics bug", "read"),
  );
  expect(owners.faults.of(SESSION, "autocompact")).toMatchObject({
    kind: "failed",
  });
  expect(owners.faults.of(SESSION, "context")).toBeUndefined();
  expect(logged.filter((l) => l.startsWith("error"))).toEqual([
    expect.stringMatching(/^error metrics lane threw: Error: metrics bug/),
    expect.stringMatching(
      /^error autocompact lane threw: Error: autocompact bug/,
    ),
  ]);
  throwing.clear();
  watched[0]!.changed();
  await clock.settle(0);
  expect(owners.faults.of(SESSION, "metrics")).toBeUndefined();
  expect(owners.faults.of(SESSION, "autocompact")).toBeUndefined();
});
