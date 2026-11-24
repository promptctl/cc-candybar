// The one holder of a per-session file: what its load finds and says, when it
// saves, and the order a restart reads back.

import {
  HeldFile,
  loadText,
  ORDER_PERIOD_MS,
} from "../../src/daemon/held-file";
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
) {
  const clock = heldClock(new Date(1_000_000));
  const kept = heldStorage<string>(read, { file: FILE, ...options });
  return {
    ...kept,
    clock,
    held: new HeldFile("store", kept.storage, clock, bound),
  };
}

const sessions = (...keys: SessionId[]) =>
  new Map(keys.map((key) => [key, `${key} value`]));

describe("a load", () => {
  test("a missing file holds nothing, says nothing and saves nothing", () => {
    const { held, saves } = holder();
    const { report } = held.load();
    expect(report).toEqual({ kind: "read", dropped: [] });
    expect(loadText(FILE, report)).toBeNull();
    expect(saves).toHaveLength(0);
  });

  test("a file that does not read is set aside beside itself, and the store starts empty and saves", () => {
    const { held, saves, asides } = holder({
      kind: "failed",
      reason: "is not JSON",
    });
    const { report } = held.load();
    expect(asides).toEqual([
      {
        from: FILE,
        to: expect.stringMatching(/^\/state\/store\.json\.unread-/),
        reason: "is not JSON",
      },
    ]);
    expect(report).toEqual({
      kind: "set-aside",
      reason: "is not JSON",
      to: asides[0]!.to,
    });
    expect(loadText(FILE, report)).toBe(
      `${FILE} could not be read: is not JSON — it is kept as ${asides[0]!.to}, and this store started empty`,
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
    expect(report).toEqual({
      kind: "refused",
      reason: "EIO: i/o error, read",
      error: "EROFS: read-only file system, rename",
    });
    expect(loadText(FILE, report)).toBe(
      `${FILE} could not be read: EIO: i/o error, read — it stays where it is, since setting it aside failed (EROFS: read-only file system, rename), and nothing is saved to it until the daemon starts again`,
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
    expect(loadText(FILE, held.load().report)).toBe(
      `${FILE}: the load dropped what this build does not read: menus.old (no menu is keyed that way in this build) in "a", "b", "c" and 2 more; a session (its value holds no picks) in "x"`,
    );
  });

  test("what was taken before the load is held, saves nothing until the load, and wins over the file", () => {
    const { held, saves } = holder({ kind: "ok", sessions: sessions(S1, S2) });
    held.take([{ kind: "put", key: S1, value: "newer" }]);
    held.take([{ kind: "heard", key: S2 }]);
    expect(saves).toHaveLength(0);
    held.load();
    expect([...saves.at(-1)!]).toEqual([
      [S2, "s2 value"],
      [S1, "newer"],
    ]);
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
