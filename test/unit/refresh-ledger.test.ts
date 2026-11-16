// [LAW:behavior-not-structure] The one ledger every source's refreshes are
// recorded in (design-docs/SOURCES-AND-FRAMES.md, "Seen"): what daemon-stats
// and a feed's summary read, and the one spelling of a refresh's event.

import { RefreshLedger } from "../../src/utils/refresh-ledger";
import { failed, ok } from "../../src/utils/outcome";
import type { LogLevel } from "../../src/utils/logger";

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
      lines: ["first", "period", "change"],
    });
    expect(ledger.snapshot()).toEqual([
      {
        name: "git",
        scope: "repo",
        refreshes: { first: 0, period: 0, change: 0 },
        failures: 0,
        abandoned: 0,
        lastMs: null,
      },
    ]);

    git.recorded("/repo", "first", ok(null), 4);
    git.recorded("/repo", "period", failed("boom", "read"), 9);
    expect(ledger.snapshot()).toEqual([
      {
        name: "git",
        scope: "repo",
        refreshes: { first: 1, period: 1, change: 0 },
        failures: 1,
        abandoned: 0,
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
      lines: ["first", "period"],
    });
    const b = ledger.declare({
      name: "var.x",
      scope: "directory",
      refresh: ["first", "period"],
      lines: ["first", "period"],
    });
    const view = ledger.declare({
      name: "var.x",
      scope: "view",
      refresh: ["first", "change"],
      lines: ["first", "change"],
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

  test("totals sum every source's refreshes by trigger, a step's included", () => {
    const { ledger } = ledgerWithLog();
    const tmux = ledger.declare({
      name: "tmux",
      scope: "pane",
      refresh: ["first", "period"],
      lines: ["first", "period"],
    });
    const usage = ledger.declare({
      name: "usage",
      scope: "session",
      refresh: ["change"],
      lines: [],
    });
    tmux.recorded("", "period", ok(null), 1);
    tmux.recorded("", "period", ok(null), 1);
    usage.recorded("", "change", ok(null), 1);

    expect(ledger.totals()).toEqual({
      first: 0,
      period: 2,
      change: 1,
      supersede: 0,
    });
  });

  // [LAW:nothing-unseen] A unit of work is its own event, a failure at warn,
  // logged once by the refresh that met it.
  test("a unit of work's refresh writes one line, a failed one at warn", () => {
    const { ledger, lines } = ledgerWithLog();
    const tmux = ledger.declare({
      name: "tmux",
      scope: "pane",
      refresh: ["period"],
      lines: ["period"],
    });
    tmux.recorded("pane=%1", "period", ok(null), 5);
    tmux.recorded("pane=%1", "period", failed("no server", "read"), 6);

    expect(lines).toEqual([
      "info tmux refresh pane=%1 by=period outcome=ok took=5ms",
      'warn tmux refresh pane=%1 by=period outcome=failed reason="no server" took=6ms',
    ]);
  });

  // A step is a fact of its unit's event (a session lane inside its
  // transcript entry's refresh): it writes a line only to say it failed.
  test("a step's refresh writes a line only when it fails, and still counts", () => {
    const { ledger, lines } = ledgerWithLog();
    const usage = ledger.declare({
      name: "usage",
      scope: "session",
      refresh: ["change"],
      lines: [],
    });
    usage.recorded("sid=s", "change", ok(null), 2);
    usage.recorded("sid=s", "change", failed("parse error", "read"), 3);

    expect(lines).toEqual([
      'warn usage refresh sid=s by=change outcome=failed reason="parse error" took=3ms',
    ]);
    expect(usage.record()).toMatchObject({
      refreshes: { change: 2 },
      failures: 1,
    });
  });

  // A backstop's clean read over a quiet session is no news: a session held
  // for hours adds nothing to the log, while a write's read still writes.
  test("a trigger the source names no line for writes one only when it fails, and still counts", () => {
    const { ledger, lines } = ledgerWithLog();
    const transcript = ledger.declare({
      name: "transcript",
      scope: "session",
      refresh: ["change", "period"],
      lines: ["change"],
    });
    transcript.recorded("sid=s", "period", ok(null), 1);
    transcript.recorded("sid=s", "change", ok(null), 2);
    transcript.recorded("sid=s", "period", failed("gone", "read"), 3);

    expect(lines).toEqual([
      "info transcript refresh sid=s by=change outcome=ok took=2ms",
      'warn transcript refresh sid=s by=period outcome=failed reason="gone" took=3ms',
    ]);
    expect(transcript.record()).toMatchObject({
      refreshes: { change: 1, period: 2 },
      failures: 1,
    });
  });
});
