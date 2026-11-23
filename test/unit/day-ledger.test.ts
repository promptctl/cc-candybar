// [LAW:behavior-not-structure] A day's totals over several transcripts count
// each API response once, whichever of them hold a copy of it; a response no
// id names is summed wherever it appears.

import {
  dayTotals,
  DayLedgersDraft,
  type DayLedgers,
} from "../../src/daemon/foundations/day-ledger";
import type { DayUsage } from "../../src/facts/world-state";

const DAY = "2026-11-23";
const YESTERDAY = "2026-11-22";

function usage(cost: number, input: number): DayUsage {
  return { cost, input, output: 0, cacheCreation: 0, cacheRead: 0 };
}

function ledgers(
  entries: ReadonlyArray<readonly [string, string | undefined, DayUsage]>,
): DayLedgers {
  const draft = new DayLedgersDraft();
  for (const [day, response, u] of entries) draft.record(day, response, u);
  return draft.done();
}

test("a response held by several transcripts is counted once in its day", () => {
  const original = ledgers([
    [DAY, "msg-1:req-1", usage(1, 10)],
    [DAY, "msg-2:req-2", usage(2, 20)],
  ]);
  const fork = ledgers([
    [DAY, "msg-1:req-1", usage(1, 10)],
    [DAY, "msg-2:req-2", usage(2, 20)],
    [DAY, "msg-3:req-3", usage(4, 40)],
  ]);
  expect(dayTotals([original, fork])).toEqual({ [DAY]: usage(7, 70) });
  // The copy alone, its original gone or never read, still counts once.
  expect(dayTotals([fork])).toEqual({ [DAY]: usage(7, 70) });
});

test("responses no id names are summed in every transcript that holds one", () => {
  const a = ledgers([[DAY, undefined, usage(1, 10)]]);
  const b = ledgers([[DAY, undefined, usage(2, 20)]]);
  expect(dayTotals([a, b])).toEqual({ [DAY]: usage(3, 30) });
});

test("each day counts its own responses", () => {
  const set = ledgers([
    [YESTERDAY, "msg-1:req-1", usage(1, 10)],
    [DAY, "msg-2:req-2", usage(2, 20)],
  ]);
  expect(dayTotals([set, set])).toEqual({
    [YESTERDAY]: usage(1, 10),
    [DAY]: usage(2, 20),
  });
});

test("a draft kept from a prior set drops days before the cut and leaves the prior unchanged", () => {
  const prior = ledgers([
    [YESTERDAY, "msg-1:req-1", usage(1, 10)],
    [DAY, "msg-2:req-2", usage(2, 20)],
  ]);
  const next = DayLedgersDraft.keeping(prior, DAY);
  next.record(DAY, "msg-3:req-3", usage(4, 40));
  next.record(DAY, undefined, usage(8, 80));
  expect(dayTotals([next.done()])).toEqual({ [DAY]: usage(14, 140) });
  expect(dayTotals([prior])).toEqual({
    [YESTERDAY]: usage(1, 10),
    [DAY]: usage(2, 20),
  });
});
