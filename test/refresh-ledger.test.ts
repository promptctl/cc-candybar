// [LAW:behavior-not-structure] The one ledger every source's refreshes are
// recorded in (design-docs/SOURCES-AND-FRAMES.md, "Seen"): what daemon-stats
// and a feed's summary read, and the one spelling of a refresh's event.

import { RefreshLedger } from "../src/utils/refresh-ledger";
import { failed, ok } from "../src/utils/outcome";
import type { LogLevel } from "../src/utils/logger";

function ledgerWithLog() {
  const lines: string[] = [];
  const ledger = new RefreshLedger((level: LogLevel, msg: string) =>
    lines.push(`${level} ${msg}`),
  );
  return { ledger, lines };
}

describe("RefreshLedger", () => {
  test("a source's record counts its refreshes by trigger, its failures and its last length", () => {
    const { ledger } = ledgerWithLog();
    const git = ledger.declare({
      name: "git",
      scope: "repo",
      refresh: ["first", "period", "change"],
    });
    expect(ledger.snapshot()).toEqual([
      {
        name: "git",
        scope: "repo",
        refreshes: { first: 0, period: 0, change: 0 },
        failures: 0,
        lastMs: null,
      },
    ]);

    git.recorded("/repo", "first", ok(null), 4);
    git.recorded("/repo", "period", failed("boom"), 9);
    expect(ledger.snapshot()).toEqual([
      {
        name: "git",
        scope: "repo",
        refreshes: { first: 1, period: 1, change: 0 },
        failures: 1,
        lastMs: 9,
      },
    ]);
    expect(git.record()).toEqual(ledger.snapshot()[0]);
  });

  test("one name in one scope is one record, however many declare it", () => {
    const { ledger } = ledgerWithLog();
    const a = ledger.declare({
      name: "var.x",
      scope: "directory",
      refresh: ["first", "period"],
    });
    const b = ledger.declare({
      name: "var.x",
      scope: "directory",
      refresh: ["first", "period"],
    });
    const view = ledger.declare({
      name: "var.x",
      scope: "view",
      refresh: ["first", "change"],
    });
    a.recorded("", "first", ok(null), 1);
    b.recorded("", "period", ok(null), 1);
    view.recorded("", "change", ok(null), 1);

    expect(
      ledger.snapshot().map((r) => [`${r.scope}/${r.name}`, r.refreshes]),
    ).toEqual([
      ["directory/var.x", { first: 1, period: 1 }],
      ["view/var.x", { first: 0, change: 1 }],
    ]);
  });

  test("totals sum every source's refreshes by trigger", () => {
    const { ledger } = ledgerWithLog();
    const tmux = ledger.declare({
      name: "tmux",
      scope: "pane",
      refresh: ["first", "period"],
    });
    const usage = ledger.declare({
      name: "usage",
      scope: "session",
      refresh: ["request"],
    });
    tmux.recorded("", "period", ok(null), 1);
    tmux.recorded("", "period", ok(null), 1);
    usage.recorded("", "request", ok(null), 1);

    expect(ledger.totals()).toEqual({
      first: 0,
      period: 2,
      change: 0,
      request: 1,
      supersede: 0,
    });
  });

  // [LAW:nothing-unseen] A request's refreshes are facts of its render event,
  // the one event of that unit of work; every other refresh is its own event,
  // and a failure is always logged, once, by the refresh that met it.
  test("a request's refresh writes no line unless it failed; every other refresh writes one", () => {
    const { ledger, lines } = ledgerWithLog();
    const usage = ledger.declare({
      name: "usage",
      scope: "session",
      refresh: ["request"],
    });
    const tmux = ledger.declare({
      name: "tmux",
      scope: "pane",
      refresh: ["period"],
    });
    usage.recorded("sid=s", "request", ok(null), 2);
    usage.recorded("sid=s", "request", failed("parse error"), 3);
    tmux.recorded("pane=%1", "period", ok(null), 5);

    expect(lines).toEqual([
      'warn usage refresh sid=s by=request outcome=failed reason="parse error" took=3ms',
      "info tmux refresh pane=%1 by=period outcome=ok took=5ms",
    ]);
  });
});
