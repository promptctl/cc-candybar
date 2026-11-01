import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileEventDelivery,
  PROBE_EVERY_MS,
  PROBE_FILE,
  fileEventsLine,
  fileEventsWarnings,
  type Delivery,
  type DeliveryNotice,
} from "../src/daemon/cache/file-events";
import { DEBOUNCE_MS, WatcherRegistry } from "../src/daemon/cache/watchers";
import { statIdentity, type IdentityRead } from "../src/utils/folder-identity";
import {
  WARNING_SEVERITY,
  collectDiagnostics,
} from "../src/render/diagnostics";
import { fakeWatches } from "./helpers/fake-watches";
import { until } from "./helpers/until";

// [LAW:behavior-not-structure] The daemon's one owner of file-event delivery
// through what it shows: what it reads, what it tells its subscribers, the
// lines it logs and its stats — never which internal function ran.

interface Rig {
  readonly folder: string;
  readonly events: FileEventDelivery;
  readonly lines: string[];
  // Every notice but the period's.
  readonly notices: DeliveryNotice[];
  readonly periods: () => number;
}

const roots: string[] = [];
const owners: FileEventDelivery[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
  jest.restoreAllMocks();
  jest.useRealTimers();
  for (const root of roots.splice(0)) {
    fs.chmodSync(root, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const fakeClock = () =>
  jest.useFakeTimers({
    doNotFake: [
      "setTimeout",
      "clearTimeout",
      "setImmediate",
      "nextTick",
      "queueMicrotask",
    ],
  });

function rig(opts: { identityOf?: IdentityRead } = {}): Rig {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "file-events-")),
  );
  roots.push(root);
  const lines: string[] = [];
  const logger = (level: string, msg: string) => lines.push(`${level} ${msg}`);
  const events = new FileEventDelivery({
    watchers: new WatcherRegistry({ logger }),
    logger,
    identityOf: opts.identityOf,
  });
  owners.push(events);
  const notices: DeliveryNotice[] = [];
  let periods = 0;
  events.subscribe((notice) =>
    notice.kind === "period" ? periods++ : notices.push(notice),
  );
  return {
    folder: path.join(root, "watch-probe"),
    events,
    lines,
    notices,
    periods: () => periods,
  };
}

const period = () => jest.advanceTimersByTime(PROBE_EVERY_MS);
// Long enough for a debounce window to close and nothing to follow it: only
// for asserting that something did not happen.
const quiet = () =>
  new Promise((resolve) => setTimeout(resolve, 3 * DEBOUNCE_MS));
const probes = (r: Rig, n: number) =>
  until(() => r.events.stats().probes === n, `probe ${n}`);
const failures = (r: Rig, n: number) =>
  until(() => r.events.stats().probeFailures === n, `failed probe ${n}`);
const kind = (r: Rig) => r.events.delivery().kind;
const warnings = (r: Rig, prefix: string) =>
  r.lines.filter((l) => l.startsWith(prefix));
const probeFile = (r: Rig) => path.join(r.folder, PROBE_FILE);

describe("FileEventDelivery", () => {
  test("before it starts it reads unmeasured, not started, with no span open", () => {
    const r = rig();
    expect(r.events.delivery()).toEqual({
      kind: "unmeasured",
      since: expect.any(Number),
      reason: "not started",
      missedSince: null,
    });
  });

  test("a watch that reports each probe stays delivering", async () => {
    const watches = fakeWatches();
    fakeClock();
    const r = rig();
    r.events.start(r.folder);
    for (let i = 1; i <= 4; i++) {
      await probes(r, i);
      watches[0]!.listener("change", PROBE_FILE);
      await quiet();
      period();
    }
    await probes(r, 5);
    expect(r.events.delivery()).toMatchObject({
      kind: "delivering",
      missedSince: null,
    });
    expect(r.events.stats()).toMatchObject({ stalls: 0, catchUps: 0 });
    expect(r.notices).toEqual([{ kind: "moved" }]);
  });

  // libuv's macOS watch drops what lands while it rebuilds its one stream.
  test("one probe unreported is not a stall", async () => {
    const watches = fakeWatches();
    fakeClock();
    const r = rig();
    r.events.start(r.folder);
    for (let i = 1; i <= 3; i++) {
      await probes(r, i);
      period();
      await probes(r, i + 1);
      watches[0]!.listener("change", PROBE_FILE);
      await quiet();
    }
    expect(r.events.stats()).toMatchObject({ stalls: 0 });
    expect(kind(r)).toBe("delivering");
  });

  test("within two periods with nothing reported it is stalled since the first unreported probe, warned once", async () => {
    fakeWatches();
    fakeClock();
    const r = rig();
    const first = Date.now();
    r.events.start(r.folder);
    await probes(r, 1);
    period();
    await probes(r, 2);
    expect(kind(r)).toBe("delivering");
    period();
    await probes(r, 3);
    expect(r.events.delivery()).toEqual({
      kind: "stalled",
      missedSince: first,
    });
    period();
    period();
    await probes(r, 5);
    expect(r.events.stats()).toMatchObject({ stalls: 1 });
    expect(warnings(r, "warn file events stalled")).toEqual([
      `warn file events stalled since=${new Date(first).toISOString()}`,
    ]);
    expect(r.notices).toEqual([{ kind: "moved" }, { kind: "moved" }]);
  });

  test("one reported event recovers a stall: one catch-up carrying its start, with the span's length logged", async () => {
    const watches = fakeWatches();
    fakeClock();
    const r = rig();
    const first = Date.now();
    r.events.start(r.folder);
    await probes(r, 1);
    period();
    period();
    await probes(r, 3);
    expect(kind(r)).toBe("stalled");
    watches[0]!.listener("change", PROBE_FILE);
    await until(() => kind(r) === "delivering", "the recovery");
    expect(r.events.delivery()).toMatchObject({ missedSince: null });
    expect(r.notices).toEqual([
      { kind: "moved" },
      { kind: "moved" },
      { kind: "caught-up", since: first },
    ]);
    expect(r.events.stats()).toMatchObject({ stalls: 1, catchUps: 1 });
    expect(warnings(r, "info file events resumed")).toEqual([
      `info file events resumed since=${new Date(first).toISOString()} missed=${2 * PROBE_EVERY_MS}ms from=stalled`,
    ]);
  });

  test("a failed probe write is unmeasured with its error, opening the span; the next write that lands measures again, and its report is one catch-up", async () => {
    const watches = fakeWatches();
    fakeClock();
    const r = rig();
    r.events.start(r.folder);
    await probes(r, 1);
    watches[0]!.listener("change", PROBE_FILE);
    await quiet();
    fs.chmodSync(probeFile(r), 0o444);
    period();
    const failedAt = Date.now();
    await failures(r, 1);
    expect(r.events.delivery()).toEqual({
      kind: "unmeasured",
      since: failedAt,
      reason: expect.stringMatching(
        /^the probe could not be written: EACCES: permission denied[^;]*$/,
      ),
      missedSince: failedAt,
    });
    // A second failure for the same reason is not another move.
    period();
    await failures(r, 2);
    expect(warnings(r, "warn file events unmeasured")).toHaveLength(1);
    fs.chmodSync(probeFile(r), 0o644);
    period();
    const landedAt = Date.now();
    await probes(r, 2);
    expect(r.events.delivery()).toEqual({
      kind: "delivering",
      unreported: [landedAt],
      missedSince: failedAt,
    });
    watches[0]!.listener("change", PROBE_FILE);
    await until(() => r.events.stats().catchUps === 1, "the catch-up");
    expect(r.notices).toEqual([
      { kind: "moved" },
      { kind: "moved" },
      { kind: "moved" },
      { kind: "caught-up", since: failedAt },
    ]);
  });

  test("stalled, then unmeasured by a failed write, then delivering by a write that lands and is reported: the row stands until one catch-up carrying the stall's start", async () => {
    const watches = fakeWatches();
    fakeClock();
    const r = rig();
    const first = Date.now();
    r.events.start(r.folder);
    await probes(r, 1);
    period();
    period();
    await probes(r, 3);
    expect(kind(r)).toBe("stalled");
    fs.chmodSync(probeFile(r), 0o444);
    period();
    await failures(r, 1);
    expect(r.events.delivery()).toMatchObject({
      kind: "unmeasured",
      missedSince: first,
    });
    fs.chmodSync(probeFile(r), 0o644);
    period();
    await probes(r, 4);
    expect(r.events.delivery()).toMatchObject({
      kind: "delivering",
      missedSince: first,
    });
    // A probe that landed is not one heard: the stall's span stays open.
    expect(fileEventsWarnings(r.events.delivery())).toEqual([
      expect.objectContaining({
        state: "delivering",
        message: expect.stringContaining(new Date(first).toISOString()),
      }),
    ]);
    watches[0]!.listener("change", PROBE_FILE);
    await until(() => r.events.stats().catchUps === 1, "the catch-up");
    expect(r.notices.filter((n) => n.kind === "caught-up")).toEqual([
      { kind: "caught-up", since: first },
    ]);
    expect(r.events.delivery()).toMatchObject({
      kind: "delivering",
      missedSince: null,
    });
    expect(fileEventsWarnings(r.events.delivery())).toEqual([]);
  });

  describe("an instrument that ends is unmeasured for good", () => {
    // Many periods after the end, with the watch firing too: no stall, no
    // catch-up, no probe, and subscribers still keep time.
    async function staysEnded(r: Rig, fire: () => void) {
      const notices = r.notices.length;
      const written = r.events.stats().probes;
      const periods = r.periods();
      for (let i = 0; i < 4; i++) period();
      fire();
      await quiet();
      expect(kind(r)).toBe("unmeasured");
      expect(r.notices).toHaveLength(notices);
      expect(r.events.stats()).toMatchObject({
        stalls: 0,
        catchUps: 0,
        probes: written,
      });
      expect(r.periods()).toBe(periods + 4);
    }

    test("a folder it cannot make", async () => {
      fakeWatches();
      fakeClock();
      const r = rig();
      fs.writeFileSync(r.folder, "");
      r.events.start(path.join(r.folder, "under-a-file"));
      expect(r.events.delivery()).toMatchObject({
        kind: "unmeasured",
        reason: expect.stringMatching(
          /^the probe folder could not be made: ENOTDIR.*; restart the daemon$/,
        ),
      });
      await staysEnded(r, () => {});
    });

    test("a folder gone as it was made", async () => {
      fakeWatches();
      fakeClock();
      const r = rig({ identityOf: () => "gone" });
      r.events.start(r.folder);
      expect(r.events.delivery()).toMatchObject({
        kind: "unmeasured",
        reason: "the probe folder was removed as it was made; restart the daemon",
      });
      await staysEnded(r, () => {});
    });

    test("a watch the OS refused", async () => {
      const r = rig();
      const watches = fakeWatches(new Set([r.folder]));
      fakeClock();
      const at = Date.now();
      r.events.start(r.folder);
      expect(r.events.delivery()).toEqual({
        kind: "unmeasured",
        since: at,
        reason: expect.stringMatching(
          /^the OS refused the probe folder's watch: .*EMFILE.*; restart the daemon$/,
        ),
        missedSince: at,
      });
      await staysEnded(r, () => {});
      expect(watches).toHaveLength(0);
    });

    test("a watch that reports a failure", async () => {
      const watches = fakeWatches();
      fakeClock();
      const r = rig();
      r.events.start(r.folder);
      await probes(r, 1);
      watches[0]!.emitter.emit("error", new Error("EIO: i/o error"));
      await until(() => kind(r) === "unmeasured", "the end");
      expect(r.events.delivery()).toMatchObject({
        reason: expect.stringMatching(
          /^the probe folder's watch failed: .*EIO: i\/o error.*; restart the daemon$/,
        ),
      });
      await staysEnded(r, () => watches[0]!.listener("change", PROBE_FILE));
    });

    test("its folder removed", async () => {
      fakeWatches();
      fakeClock();
      const r = rig();
      r.events.start(r.folder);
      await probes(r, 1);
      fs.rmSync(r.folder, { recursive: true });
      period();
      const at = Date.now();
      expect(r.events.delivery()).toEqual({
        kind: "unmeasured",
        since: at,
        reason: "the probe folder was removed; restart the daemon",
        missedSince: at,
      });
      await staysEnded(r, () => {});
    });

    test("its folder unreadable", async () => {
      fakeWatches();
      fakeClock();
      let refused = false;
      const identityOf: IdentityRead = (folder) => {
        if (refused) throw new Error("EACCES: permission denied");
        return statIdentity(folder);
      };
      const r = rig({ identityOf });
      r.events.start(r.folder);
      await probes(r, 1);
      refused = true;
      period();
      expect(r.events.delivery()).toMatchObject({
        kind: "unmeasured",
        reason:
          "the probe folder cannot be read: EACCES: permission denied; restart the daemon",
      });
      await staysEnded(r, () => {});
    });

    test("its folder replaced at the path", async () => {
      fakeWatches();
      fakeClock();
      let replaced = false;
      const identityOf: IdentityRead = (folder) => {
        const real = statIdentity(folder);
        return real === "gone" || !replaced
          ? real
          : { ...real, birthtimeNs: real.birthtimeNs + 1n };
      };
      const r = rig({ identityOf });
      r.events.start(r.folder);
      await probes(r, 1);
      replaced = true;
      period();
      expect(r.events.delivery()).toMatchObject({
        kind: "unmeasured",
        reason: "the probe folder was replaced; restart the daemon",
      });
      await staysEnded(r, () => {});
    });

    test("a stall ended by its folder's removal keeps the stall's span open, and never catches up", async () => {
      fakeWatches();
      fakeClock();
      const r = rig();
      const first = Date.now();
      r.events.start(r.folder);
      await probes(r, 1);
      period();
      period();
      await probes(r, 3);
      fs.rmSync(r.folder, { recursive: true });
      period();
      expect(r.events.delivery()).toMatchObject({
        kind: "unmeasured",
        missedSince: first,
      });
      const notices = r.notices.length;
      for (let i = 0; i < 4; i++) period();
      await quiet();
      expect(r.notices).toHaveLength(notices);
      expect(r.events.stats().catchUps).toBe(0);
    });
  });

  test("a probe still in flight when the owner closes judges nothing", async () => {
    fakeWatches();
    fakeClock();
    let fail: (e: Error) => void = () => {};
    jest
      .spyOn(fs.promises, "writeFile")
      .mockImplementation(
        () => new Promise<void>((_resolve, reject) => (fail = reject)),
      );
    const r = rig();
    r.events.start(r.folder);
    r.events.close();
    fail(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }));
    await quiet();
    expect(r.events.delivery()).toMatchObject({ kind: "delivering" });
    expect(r.lines.filter((l) => l.includes("unmeasured"))).toEqual([]);
  });

  // A loaded Mac's fseventsd can stop delivering altogether, and then this
  // reads the stall it exists to catch: CI's runner judges it.
  test("a real watch reports the probe's own write, so a folder nobody else writes keeps delivering", async () => {
    fakeClock();
    const r = rig();
    r.events.start(r.folder);
    for (let i = 0; i < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      period();
    }
    await quiet();
    expect(r.events.stats()).toMatchObject({ stalls: 0 });
    expect(kind(r)).toBe("delivering");
  });
});

describe("the bar's row and daemon-stats' line", () => {
  const AT = Date.parse("2026-10-27T04:00:00.000Z");
  const LATER = AT + 90_000;

  test("nothing while delivering", () => {
    expect(
      fileEventsWarnings({
        kind: "delivering",
        unreported: [LATER],
        missedSince: null,
      }),
    ).toEqual([]);
  });

  test("delivering with the span still open names its start: nothing has been heard since", () => {
    expect(
      fileEventsWarnings({
        kind: "delivering",
        unreported: [LATER],
        missedSince: AT,
      }),
    ).toEqual([
      {
        kind: "file-events",
        state: "delivering",
        message:
          "file events unconfirmed since 2026-10-27T04:00:00.000Z: the probe written to test them has not been heard yet, so an edit to the config made since may not have reloaded",
      },
    ]);
  });

  test("a stall names the span's start, and composes into one warning", () => {
    const delivery: Delivery = { kind: "stalled", missedSince: AT };
    const warned = fileEventsWarnings(delivery);
    expect(warned).toEqual([
      {
        kind: "file-events",
        state: "stalled",
        message:
          "file events stopped at 2026-10-27T04:00:00.000Z; the OS has delivered none since, not even for a file the daemon wrote to test it, so an edit to the config will not reload until they resume",
      },
    ]);
    const diagnostics = collectDiagnostics(
      "sid",
      "request",
      [],
      [],
      warned.map((w) => ({ about: w.kind, text: w.message, copy: w.message })),
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: WARNING_SEVERITY,
        message: warned[0]!.message,
      }),
    ]);
  });

  test("unmeasured names its reason and the span's start", () => {
    expect(
      fileEventsWarnings({
        kind: "unmeasured",
        since: LATER,
        reason: "the probe could not be written: ENOSPC",
        missedSince: AT,
      }),
    ).toEqual([
      {
        kind: "file-events",
        state: "unmeasured",
        message:
          "since 2026-10-27T04:00:00.000Z, the daemon cannot check whether file events are arriving: the probe could not be written: ENOSPC",
      },
    ]);
  });

  test("nothing for an owner never started: no span is open, so no edit can have gone unheard", () => {
    expect(
      fileEventsWarnings({
        kind: "unmeasured",
        since: AT,
        reason: "not started",
        missedSince: null,
      }),
    ).toEqual([]);
  });

  test("daemon-stats' line reads each state", () => {
    const counts = { stalls: 2, catchUps: 1, probes: 9, probeFailures: 3 };
    const line = (delivery: Delivery) =>
      fileEventsLine({ delivery, ...counts });
    const tail = "stalls=2 catchUps=1 probes=9 probeFailures=3";
    expect(
      line({ kind: "delivering", unreported: [], missedSince: null }),
    ).toBe(`delivering ${tail}`);
    expect(
      line({ kind: "delivering", unreported: [LATER], missedSince: AT }),
    ).toBe(`delivering unvouched since 2026-10-27T04:00:00.000Z ${tail}`);
    expect(line({ kind: "stalled", missedSince: AT })).toBe(
      `stalled unvouched since 2026-10-27T04:00:00.000Z ${tail}`,
    );
    // A stall then a failed write: the span is the stall's, older than the
    // reason, and the line names both, as the bar's row names the span.
    expect(
      line({
        kind: "unmeasured",
        since: LATER,
        reason: "the probe could not be written: ENOSPC",
        missedSince: AT,
      }),
    ).toBe(
      `unmeasured since 2026-10-27T04:01:30.000Z reason="the probe could not be written: ENOSPC" unvouched since 2026-10-27T04:00:00.000Z ${tail}`,
    );
    expect(
      line({
        kind: "unmeasured",
        since: AT,
        reason: "not started",
        missedSince: null,
      }),
    ).toBe(
      `unmeasured since 2026-10-27T04:00:00.000Z reason="not started" ${tail}`,
    );
  });
});
