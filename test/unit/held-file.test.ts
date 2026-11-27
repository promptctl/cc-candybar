// The one holder of a per-session file: what its load finds and says, when it
// saves, and the order a restart reads back.

import { HeldFile, ORDER_PERIOD_MS } from "../../src/daemon/held-file";
import {
  reportLine,
  reportText,
  type StoreStanding,
} from "../../src/daemon/foundations/stored-file";
import {
  sessionIdOf,
  type SessionId,
} from "../../src/daemon/foundations/session-id";
import { heldClock } from "../helpers/held-clock";
import { heldStorage, type HeldRead } from "../helpers/held-storage";

const S1 = sessionIdOf("s1");
const S2 = sessionIdOf("s2");
const S3 = sessionIdOf("s3");
const FILE = "/state/store.json";

function holder(
  read?: HeldRead<string>,
  options: Parameters<typeof heldStorage<string>>[1] = {},
  bound?: number,
  same?: (held: string, put: string) => boolean,
  told: (standing: StoreStanding) => void = () => {},
) {
  const clock = heldClock(new Date(1_000_000));
  const kept = heldStorage<string>(read, { file: FILE, ...options });
  return {
    ...kept,
    clock,
    held: new HeldFile("The store", kept.storage, clock, told, bound, same),
  };
}

const sessions = (...keys: SessionId[]) =>
  new Map(keys.map((key) => [key, `${key} value`]));

describe("a load", () => {
  // [LAW:nothing-unseen] A load that found nothing and one that never ran
  // are told apart in the log, while the bar says nothing of either.
  test("a missing file holds nothing, saves nothing, and only the log says so", () => {
    const { held, saves } = holder();
    const { report } = held.load();
    expect(report).toEqual({
      store: "The store",
      file: FILE,
      found: { kind: "absent" },
    });
    expect(reportText(report)).toBeNull();
    expect(reportLine(report)).toBe(
      `The store: no file at ${FILE}, holding nothing`,
    );
    expect(saves).toHaveLength(0);
  });

  test("a file that reads says how many sessions it held, in the log alone", () => {
    const { held } = holder({ kind: "ok", sessions: sessions(S1, S2) });
    const { report } = held.load();
    expect(reportText(report)).toBeNull();
    expect(reportLine(report)).toBe(
      `The store: read ${FILE}, sessions=2 dropped=0`,
    );
  });

  test("a file that does not read is set aside beside itself, and the store starts empty and saves", () => {
    const { held, saves, asides } = holder({
      kind: "failed",
      reason: "is not JSON",
    });
    const { report } = held.load();
    expect(asides).toEqual([{ from: FILE, to: `${FILE}.unread-0` }]);
    expect(report.found).toEqual({
      kind: "set-aside",
      reason: "is not JSON",
      to: `${FILE}.unread-0`,
    });
    expect(reportText(report)).toBe(
      `The store could not be read: is not JSON — it is kept as ${FILE}.unread-0, and the store started again from empty`,
    );
    expect([...held.entries()]).toEqual([]);
    held.take([{ kind: "put", key: S1, value: "a" }]);
    expect([...saves.at(-1)!]).toEqual([[S1, "a"]]);
  });

  // [LAW:no-silent-failure] Nothing is ever written over bytes that did not
  // read: a file that cannot be set aside is never saved to.
  test("a file that can be neither read nor set aside is never saved to, and says so", async () => {
    const { held, saves, flushes } = holder(
      { kind: "failed", reason: "EIO: i/o error, read" },
      { refuseAside: new Error("EROFS: read-only file system, rename") },
    );
    const { report } = held.load();
    expect(report.found).toEqual({
      kind: "refused",
      reason: "EIO: i/o error, read",
      error: "EROFS: read-only file system, rename",
    });
    expect(reportText(report)).toBe(
      `The store could not be read: EIO: i/o error, read — it stays where it is, since setting it aside failed (EROFS: read-only file system, rename), and nothing is saved to it until the daemon starts again`,
    );
    held.take([{ kind: "put", key: S1, value: "a" }]);
    held.take([{ kind: "heard", key: S1 }]);
    await held.close();
    expect(saves).toHaveLength(0);
    expect(flushes()).toBe(1);
    expect([...held.entries()]).toEqual([[S1, "a"]]);
  });

  test("what the load dropped is said grouped by what and why, three sessions named", () => {
    const dropped = ["a", "b", "c", "d", "e"].map((session) => ({
      session,
      part: "menus.old",
      why: "no menu is keyed that way in this build",
    }));
    const { held } = holder({
      kind: "ok",
      sessions: sessions(S1),
      dropped: [
        ...dropped,
        { session: "x", part: null, why: "its value holds no picks" },
      ],
    });
    expect(reportText(held.load().report)).toBe(
      `The store (${FILE}): the load dropped what this build does not read: menus.old (no menu is keyed that way in this build) in "a", "b", "c" and 2 more; a session (its value holds no picks) in "x"`,
    );
  });

  // [LAW:nothing-unseen] The bar's event leaves; the log keeps every name.
  test("the log names every session the load dropped", () => {
    const { held } = holder({
      kind: "ok",
      sessions: sessions(S1),
      dropped: ["a", "b", "c", "d"].map((session) => ({
        session,
        part: null,
        why: "its value holds no picks",
      })),
    });
    expect(reportLine(held.load().report)).toBe(
      `The store: read ${FILE}, sessions=1 dropped=4: a session (its value holds no picks) in "a", "b", "c", "d"`,
    );
  });

  // [LAW:no-ambient-temporal-coupling] What is taken before the load is held,
  // but nothing reads it before the file's sessions are under it.
  test("a read before the load throws", () => {
    const { held } = holder({ kind: "ok", sessions: sessions(S1) });
    held.take([{ kind: "put", key: S2, value: "b" }]);
    expect(() => held.get(S1)).toThrow("The store is read before its load");
    expect(() => held.entries()).toThrow("The store is read before its load");
  });

  test("what was taken before the load is held, saves nothing until the load, and wins over the file", () => {
    const { held, saves } = holder({ kind: "ok", sessions: sessions(S1, S2) });
    held.take([{ kind: "put", key: S1, value: "newer" }]);
    held.take([{ kind: "heard", key: S2 }]);
    expect(saves).toHaveLength(0);
    held.load();
    // Replayed in the order taken: the put moves s1 to the newest end, then
    // the hearing moves s2 past it.
    expect([...saves.at(-1)!]).toEqual([
      [S1, "newer"],
      [S2, "s2 value"],
    ]);
  });

  test("a drop taken before the load is replayed over the file's sessions", () => {
    const { held, saves } = holder({ kind: "ok", sessions: sessions(S1, S2) });
    held.take([{ kind: "put", key: S1, value: null }]);
    held.load();
    expect([...held.entries().keys()]).toEqual([S2]);
    expect([...saves.at(-1)!.keys()]).toEqual([S2]);
  });

  test("a second load throws", () => {
    const { held } = holder();
    held.load();
    expect(() => held.load()).toThrow("The store is loaded twice");
  });

  test("a file over the bound loses its oldest at the load, and saves", () => {
    const { held, saves } = holder(
      { kind: "ok", sessions: sessions(S1, S2, S3) },
      {},
      2,
    );
    expect(held.load().evicted).toEqual([S1]);
    expect([...saves.at(-1)!.keys()]).toEqual([S2, S3]);
  });
});

describe("the order a restart reads", () => {
  test("a hearing alone saves within the order period, once however many come", () => {
    const { held, saves, clock } = holder({
      kind: "ok",
      sessions: sessions(S1, S2),
    });
    held.load();
    held.take([{ kind: "heard", key: S1 }]);
    held.take([{ kind: "heard", key: S2 }]);
    held.take([{ kind: "heard", key: S1 }]);
    clock.advance(ORDER_PERIOD_MS - 1);
    expect(saves).toHaveLength(0);
    clock.advance(1);
    expect(saves.map((saved) => [...saved.keys()])).toEqual([[S2, S1]]);
    clock.advance(ORDER_PERIOD_MS);
    expect(saves).toHaveLength(1);
  });

  test("hearing the newest moves nothing and arms no write", () => {
    const { held, saves, clock } = holder({
      kind: "ok",
      sessions: sessions(S1, S2),
    });
    held.load();
    held.take([{ kind: "heard", key: S2 }]);
    held.take([{ kind: "heard", key: sessionIdOf("unheld") }]);
    expect(clock.pending()).toBe(0);
    clock.advance(ORDER_PERIOD_MS);
    expect(saves).toHaveLength(0);
  });

  test("a write carries the order with it, and the period's write is then not owed", () => {
    const { held, saves, clock } = holder({
      kind: "ok",
      sessions: sessions(S1, S2),
    });
    held.load();
    held.take([{ kind: "heard", key: S1 }]);
    held.take([{ kind: "put", key: S3, value: "c" }]);
    expect([...saves.at(-1)!.keys()]).toEqual([S2, S1, S3]);
    clock.advance(ORDER_PERIOD_MS);
    expect(saves).toHaveLength(1);
  });

  test("a close writes an order the period still owes", async () => {
    const { held, saves } = holder({ kind: "ok", sessions: sessions(S1, S2) });
    held.load();
    held.take([{ kind: "heard", key: S1 }]);
    await held.close();
    expect(saves.map((saved) => [...saved.keys()])).toEqual([[S2, S1]]);
  });

  test("a hearing after the close arms no write", async () => {
    const { held, saves, clock } = holder({
      kind: "ok",
      sessions: sessions(S1, S2),
    });
    held.load();
    await held.close();
    held.take([{ kind: "heard", key: S1 }]);
    expect(clock.pending()).toBe(0);
    expect(saves).toHaveLength(0);
  });

  test("a put of what the session holds is a hearing: it moves only the place", () => {
    const { held, saves, clock } = holder(
      { kind: "ok", sessions: sessions(S1, S2) },
      {},
      Infinity,
      (a, b) => a === b,
    );
    held.load();
    held.take([{ kind: "put", key: S1, value: "s1 value" }]);
    expect(saves).toHaveLength(0);
    clock.advance(ORDER_PERIOD_MS);
    expect(saves.map((saved) => [...saved.keys()])).toEqual([[S2, S1]]);
  });

  test("a drop of a session it does not hold saves nothing and arms no write", () => {
    const { held, saves, clock } = holder({
      kind: "ok",
      sessions: sessions(S1),
    });
    held.load();
    held.take([{ kind: "put", key: S2, value: null }]);
    clock.advance(ORDER_PERIOD_MS);
    expect(saves).toHaveLength(0);
  });

  // [LAW:no-silent-failure] A save that throws leaves the file behind the
  // map, so what it carried is still owed: the close writes it.
  test("a save that throws is still owed, and the close writes it", async () => {
    let refuse = true;
    const { held, saves } = holder(
      { kind: "ok", sessions: sessions(S1) },
      {
        save: () => {
          if (refuse) throw new Error("ENOSPC: no space left on device");
        },
      },
    );
    held.load();
    expect(() => held.take([{ kind: "put", key: S2, value: "b" }])).toThrow(
      "ENOSPC",
    );
    refuse = false;
    await held.close();
    expect([...saves.at(-1)!]).toEqual([
      [S1, "s1 value"],
      [S2, "b"],
    ]);
  });

  test("the bound drops the session written or heard longest ago", () => {
    const { held, saves } = holder(
      { kind: "ok", sessions: sessions(S1, S2) },
      {},
      2,
    );
    held.load();
    held.take([{ kind: "heard", key: S1 }]);
    expect(held.take([{ kind: "put", key: S3, value: "c" }])).toEqual([S2]);
    expect([...saves.at(-1)!.keys()]).toEqual([S1, S3]);
  });
});

// [LAW:no-silent-failure] What its storage tells of a write is the owner's to
// hear: the file is behind with the error's reason, or it is not.
describe("a write its storage tells", () => {
  test("is the file's standing, behind with the error, then not behind", () => {
    const told: StoreStanding[] = [];
    const { held, land } = holder(
      undefined,
      {},
      undefined,
      undefined,
      (standing) => told.push(standing),
    );
    held.load();
    land({ ok: false, error: new Error("ENOSPC") });
    land({ ok: true });
    expect(told).toEqual([
      { store: "The store", file: FILE, behind: "ENOSPC" },
      { store: "The store", file: FILE, behind: null },
    ]);
  });
});
