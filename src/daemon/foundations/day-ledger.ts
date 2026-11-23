import type { DayUsage } from "../../facts/world-state";
import { addDay, EMPTY_DAY } from "./today-facts";

// [LAW:one-source-of-truth] One day's usage by the API response it came from.
// A forked or resumed session's transcript holds copies of earlier responses
// under their original ids, marked as a fork or not, and the file it copied
// from may be gone or unread. So a day over several files counts each id once,
// whichever files hold it. A response no id names cannot be matched with a
// copy, so it is summed as it stands.
export interface DayLedger {
  readonly responses: ReadonlyMap<string, DayUsage>;
  readonly unnamed: DayUsage;
}

// A ledger per day key.
export type DayLedgers = ReadonlyMap<string, DayLedger>;

interface DayLedgerDraft {
  readonly responses: Map<string, DayUsage>;
  readonly unnamed: DayUsage;
}

// Ledgers being built: every write lands in a fresh copy, so a prior fold
// another refold shares is never mutated.
export class DayLedgersDraft {
  private readonly days = new Map<string, DayLedgerDraft>();

  // The ledgers of `from` on days at or after `keep` (day keys sort as dates).
  static keeping(from: DayLedgers, keep: string): DayLedgersDraft {
    const draft = new DayLedgersDraft();
    for (const [day, ledger] of from) {
      if (day < keep) continue;
      draft.days.set(day, {
        responses: new Map(ledger.responses),
        unnamed: { ...ledger.unnamed },
      });
    }
    return draft;
  }

  // One response's usage on `day`; `undefined` is a response no id names.
  record(day: string, response: string | undefined, usage: DayUsage): void {
    const ledger = this.ledger(day);
    if (response === undefined) addDay(ledger.unnamed, usage);
    else ledger.responses.set(response, usage);
  }

  // Every ledger of `from`, a response already held kept as it is: a copy
  // carries the usage of the response it copies.
  union(from: DayLedgers): void {
    for (const [day, ledger] of from) {
      const into = this.ledger(day);
      addDay(into.unnamed, ledger.unnamed);
      for (const [response, usage] of ledger.responses) {
        if (!into.responses.has(response)) into.responses.set(response, usage);
      }
    }
  }

  done(): DayLedgers {
    return this.days;
  }

  private ledger(day: string): DayLedgerDraft {
    const found = this.days.get(day);
    if (found !== undefined) return found;
    const fresh = { responses: new Map(), unnamed: { ...EMPTY_DAY } };
    this.days.set(day, fresh);
    return fresh;
  }
}

// [LAW:effects-at-boundaries] The day totals over every ledger set given, each
// response counted once per day. A record, not a Map: day totals cross a
// process as JSON (src/facts/world-state.ts).
export function dayTotals(
  sets: Iterable<DayLedgers>,
): Readonly<Record<string, DayUsage>> {
  const all = new DayLedgersDraft();
  for (const set of sets) all.union(set);
  const totals: Record<string, DayUsage> = {};
  for (const [day, ledger] of all.done()) {
    const total = { ...ledger.unnamed };
    for (const usage of ledger.responses.values()) addDay(total, usage);
    totals[day] = total;
  }
  return totals;
}
