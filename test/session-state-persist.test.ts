import fs, {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionState } from "../src/renderer/session-state";
import {
  SESSION_STATE_FILE,
  SessionFile,
  type SessionFileStorage,
  type SessionPicks,
} from "../src/daemon/session-state-file";
import {
  EPHEMERAL_HISTORY_STORAGE,
  HeldStores,
} from "../src/daemon/held-stores";
import { throughout, until } from "../scripts/lib/until";
import { systemTimekeeper } from "../scripts/lib/system-clock";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const S1 = sessionIdOf("s1");
const S2 = sessionIdOf("s2");
const A_2 = sessionIdOf("a");
const B = sessionIdOf("b");
const C = sessionIdOf("c");

describe("the session state's file", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-state-test-"));
    file = join(dir, "session-state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A daemon over the file: the host's held stores, loaded as it serves, and
  // a renderer built from them, each of its writes taken as a turn's are.
  const daemonOver = (
    session: SessionFileStorage<SessionPicks>,
    maxSessions?: number,
  ) => {
    const stores = new HeldStores(
      {
        session,
        history: EPHEMERAL_HISTORY_STORAGE,
      },
      () => {},
    );
    stores.load();
    const state = new SessionState(stores.current().sessions, maxSessions);
    const turn = (write: (state: SessionState) => void): void => {
      write(state);
      stores.take(state.drain());
    };
    return { state, turn, stores };
  };
  const storage = (log?: (level: string, line: string) => void) =>
    new SessionFile(SESSION_STATE_FILE, file, systemTimekeeper, 0, log);
  const onDisk = () => JSON.parse(readFileSync(file, "utf8"));

  // A daemon started after one closed reads what it closed with: flushed so
  // no debounced write outlives the temp dir.
  const restarted = async (maxSessions?: number) => {
    const daemon = daemonOver(storage(), maxSessions);
    await daemon.stores.close();
    return daemon.state;
  };

  // [LAW:no-ambient-temporal-coupling] What lands after a daemon closed stays
  // in memory: a late write can't land over the file a next daemon took up.
  it("a write after close reaches memory and not the file", async () => {
    const session = storage();
    const { state, turn, stores } = daemonOver(session);
    turn((s) => s.set(S1, "theme", "nord"));
    await stores.close();
    const closedWith = readFileSync(file, "utf8");
    expect(JSON.parse(closedWith)).toEqual({ s1: { theme: "nord" } });

    turn((s) => s.set(S1, "theme", "dracula"));
    expect(state.get(S1, "theme")).toBe("dracula");
    expect(stores.current().sessions[S1]).toEqual({ theme: "dracula" });
    await session.flush();
    expect(readFileSync(file, "utf8")).toBe(closedWith);
  });

  // [LAW:nothing-unseen] Each flush says what it wrote, how long it took,
  // and how much of that it held the daemon's one thread.
  it("each flush logs the bytes and sessions it wrote and how long it took", async () => {
    const logged: string[] = [];
    const session = storage((_level, line) => logged.push(line));
    session.save(new Map([[S1, { theme: "dracula" }]]));
    await session.flush();
    const bytes = Buffer.byteLength(readFileSync(file, "utf8"));
    expect(logged.at(-1)).toMatch(
      new RegExp(
        `^session-state saved bytes=${bytes} sessions=1 took=\\d+ms held=\\d+ms$`,
      ),
    );
  });

  // [LAW:parse-dont-validate] The file's keys cross the session id
  // checkpoint on load: a refused key is reported and dropped, and the
  // sessions beside it load whole.
  it("a stored key the session id checkpoint refuses is reported and not loaded", async () => {
    writeFileSync(
      file,
      JSON.stringify({ "a/b": { theme: "nord" }, [S1]: { theme: "dracula" } }),
    );
    const logged: string[] = [];
    const loaded = storage((_level, line) => logged.push(line)).load();
    expect([...loaded]).toEqual([[S1, { theme: "dracula" }]]);
    expect(logged).toContainEqual(
      expect.stringMatching(
        /^session-state load: dropped session key "a\/b": session id contains a path separator/,
      ),
    );
  });

  // The write syncs to the real disk, and a datasync on a busy CI runner has
  // outlasted until's default 5 s: the budget is when a write that never
  // lands fails, not how long one that does is waited on.
  const settled = (done: () => boolean): Promise<void> =>
    until(done, "the write's landing", 20_000);

  // The debounced write reaches the disk off the daemon's thread: no flush is
  // called, and the file still lands whole, owner-only.
  it("a debounced save lands on disk by itself and says so", async () => {
    const logged: string[] = [];
    storage((_level, line) => logged.push(line)).save(
      new Map([[S1, { theme: "nord" }]]),
    );
    await settled(() =>
      logged.some((l) => l.startsWith("session-state saved")),
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      s1: { theme: "nord" },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  // [LAW:no-ambient-temporal-coupling] Writes land in the order they began: a
  // flush while the debounced write is on its way waits for it, then lands
  // the newer state, so older state never lands over newer.
  it("a flush while the debounced write is in flight lands after it, with the newer state", async () => {
    const logged: string[] = [];
    const session = storage((_level, line) => logged.push(line));
    const rename = fs.promises.rename;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = jest
      .spyOn(fs.promises, "rename")
      .mockImplementationOnce(async (from, to) => {
        await held;
        return rename(from, to);
      });
    let flushed: Promise<void>;
    try {
      session.save(new Map([[S1, { theme: "old" }]]));
      await settled(() => spy.mock.calls.length === 1);
      session.save(new Map([[S1, { theme: "new" }]]));
      flushed = session.flush();
      release();
      await flushed;
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      s1: { theme: "new" },
    });
    expect(fs.readdirSync(dir)).toEqual(["session-state.json"]);
    expect(logged.filter((l) => l.includes("save failed"))).toEqual([]);
    expect(logged.filter((l) => l.includes("saved"))).toHaveLength(2);
  });

  // [LAW:no-ambient-temporal-coupling] The host goes on moving its own map
  // while a write is on its way, so a pick made then is pending still when
  // that write lands, and the close writes it.
  it("a pick made while a write is on its way is not lost", async () => {
    const rename = fs.promises.rename;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = jest
      .spyOn(fs.promises, "rename")
      .mockImplementationOnce(async (from, to) => {
        await held;
        return rename(from, to);
      });
    try {
      const daemon = daemonOver(storage());
      daemon.turn((s) => s.set(S1, "theme", "nord"));
      await settled(() => spy.mock.calls.length === 1);
      daemon.turn((s) => s.set(S2, "theme", "dracula"));
      release();
      await daemon.stores.close();
    } finally {
      spy.mockRestore();
    }
    expect(onDisk()).toEqual({
      s1: { theme: "nord" },
      s2: { theme: "dracula" },
    });
  });

  // A flush the disk refuses drops nothing: it rejects with the reason, the
  // snapshot stays pending, and the next flush lands it.
  it("a flush the disk refuses rejects and leaves its snapshot for the next flush", async () => {
    const logged: string[] = [];
    const session = storage((_level, line) => logged.push(line));
    const spy = jest
      .spyOn(fs.promises, "writeFile")
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC" }),
      );
    try {
      session.save(new Map([[S1, { theme: "nord" }]]));
      await expect(session.flush()).rejects.toThrow(
        expect.objectContaining({ code: "ENOSPC" }),
      );
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(file)).toBe(false);
    expect(logged.filter((l) => l.includes("save failed"))).toHaveLength(1);
    await session.flush();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      s1: { theme: "nord" },
    });
  });

  // The write in flight lands; the newer flush the disk refuses rejects and
  // leaves its state pending, so the older state stands until a flush lands.
  it("a flush refused behind a write in flight leaves that write's state, and its own pending", async () => {
    const session = storage();
    const rename = fs.promises.rename;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const renameSpy = jest
      .spyOn(fs.promises, "rename")
      .mockImplementationOnce(async (from, to) => {
        await held;
        return rename(from, to);
      });
    let writeSpy: jest.SpiedFunction<typeof fs.promises.writeFile> | null =
      null;
    try {
      session.save(new Map([[S1, { theme: "old" }]]));
      await until(() => renameSpy.mock.calls.length === 1, "the held rename");
      writeSpy = jest
        .spyOn(fs.promises, "writeFile")
        .mockRejectedValueOnce(
          Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC" }),
        );
      session.save(new Map([[S1, { theme: "new" }]]));
      const flushed = session.flush();
      release();
      await expect(flushed).rejects.toThrow(/ENOSPC/);
    } finally {
      writeSpy?.mockRestore();
      renameSpy.mockRestore();
    }
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      s1: { theme: "old" },
    });
    await session.flush();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      s1: { theme: "new" },
    });
    expect(fs.readdirSync(dir)).toEqual(["session-state.json"]);
  });

  // A snapshot its kind cannot encode fails that one write, and the next
  // write still runs.
  it("a snapshot that cannot be encoded fails its write, not every later one", async () => {
    const logged: string[] = [];
    let encodable = false;
    const session = new SessionFile(
      {
        ...SESSION_STATE_FILE,
        record: (kv) => {
          if (!encodable) throw new Error("not encodable");
          return kv;
        },
      },
      file,
      systemTimekeeper,
      0,
      (_level, line) => logged.push(line),
    );
    session.save(new Map([[S1, { theme: "nord" }]]));
    await expect(session.flush()).rejects.toThrow("not encodable");
    encodable = true;
    await session.flush();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      s1: { theme: "nord" },
    });
  });

  // A disk that refuses a write is retried by the next save or shutdown's
  // flush, not on a timer: an idle daemon does not spin on it.
  it("a debounced write the disk refuses is tried once, not on a timer", async () => {
    const blocked = join(dir, "not-a-folder");
    writeFileSync(blocked, "");
    const logged: string[] = [];
    new SessionFile(
      SESSION_STATE_FILE,
      join(blocked, "session-state.json"),
      systemTimekeeper,
      0,
      (_level, line) => logged.push(line),
    ).save(new Map([[S1, { theme: "nord" }]]));
    await settled(() => logged.some((l) => l.includes("save failed")));
    await throughout(
      () => logged.filter((l) => l.includes("save failed")).length === 1,
      "one failed write, not retried",
      100,
    );
  });

  it("survives a daemon restart: a fresh instance reads identical values", async () => {
    const first = daemonOver(storage());
    first.turn((s) => s.set(S1, "theme", "dracula"));
    first.turn((s) => s.set(S1, "displayStyle", "capsule"));
    first.turn((s) => s.set(S2, "endcaps", "plain"));
    await first.stores.close();

    const reborn = await restarted();
    expect(reborn.get(S1, "theme")).toBe("dracula");
    expect(reborn.get(S1, "displayStyle")).toBe("capsule");
    expect(reborn.get(S2, "endcaps")).toBe("plain");
  });

  it("clear() persists removal across a restart", async () => {
    const first = daemonOver(storage());
    first.turn((s) => s.set(S1, "endcaps", "plain"));
    first.turn((s) => s.clear(S1, "endcaps"));
    await first.stores.close();

    expect((await restarted()).get(S1, "endcaps")).toBeNull();
    expect(onDisk()).toEqual({});
  });

  // [LAW:types-are-the-program] Both copies are ordered by write, so the
  // file keeps the recency the renderer's bound evicts by.
  it("a restart keeps the order the sessions were last written in", async () => {
    const first = daemonOver(storage());
    first.turn((s) => s.set(A_2, "t", "1"));
    first.turn((s) => s.set(B, "t", "2"));
    first.turn((s) => s.set(A_2, "t", "3"));
    await first.stores.close();
    expect(Object.keys(onDisk())).toEqual(["b", "a"]);

    const reborn = await restarted(2);
    reborn.set(C, "t", "4");
    expect(reborn.get(B, "t")).toBeNull();
    expect(reborn.get(A_2, "t")).toBe("3");
  });

  it("debounces: no write before the window elapses, then one atomic file", async () => {
    jest.useFakeTimers();
    try {
      const session = new SessionFile(
        SESSION_STATE_FILE,
        file,
        systemTimekeeper,
        500,
      );
      session.save(new Map([[S1, { theme: "nord" }]]));
      session.save(new Map([[S1, { theme: "nord", style: "muted" }]]));
      jest.advanceTimersByTime(499);
      expect(existsSync(file)).toBe(false);

      // The window elapses; the write then reaches the disk off the thread.
      jest.advanceTimersByTime(1);
      jest.useRealTimers();
      await settled(() => existsSync(file));

      const reborn = await restarted();
      expect(reborn.get(S1, "theme")).toBe("nord");
      expect(reborn.get(S1, "style")).toBe("muted");
    } finally {
      jest.useRealTimers();
    }
  });

  it("corrupt file hydrates to empty state, not a throw", async () => {
    writeFileSync(file, "{ not valid json");
    const ss = await restarted();
    expect(ss.get(S1, "theme")).toBeNull();
  });

  it("wrong-shape file hydrates to empty state", async () => {
    writeFileSync(file, JSON.stringify({ s1: { theme: 42 } }));
    const ss = await restarted();
    expect(ss.get(S1, "theme")).toBeNull();
  });

  it("missing file hydrates to empty state", async () => {
    const ss = await restarted();
    expect(ss.get(S1, "theme")).toBeNull();
  });

  it("bounds the store: oldest idle session is evicted past the cap", async () => {
    const ss = new SessionState(undefined, 2);
    ss.set(A_2, "theme", "1");
    ss.set(B, "theme", "2");
    ss.set(C, "theme", "3"); // pushes "a" out
    expect(ss.get(A_2, "theme")).toBeNull();
    expect(ss.get(B, "theme")).toBe("2");
    expect(ss.get(C, "theme")).toBe("3");
  });

  // A read moves nothing, so the host's copy, which hears only writes, is
  // ordered as this one is.
  it("a read does not protect a session from eviction", async () => {
    const ss = new SessionState(undefined, 2);
    ss.set(A_2, "theme", "1");
    ss.set(B, "theme", "2");
    ss.get(A_2, "theme");
    ss.set(C, "theme", "3");
    expect(ss.get(A_2, "theme")).toBeNull();
    expect(ss.get(B, "theme")).toBe("2");
  });

  it("over-cap file is trimmed on hydrate and the trim is persisted to disk", async () => {
    writeFileSync(
      file,
      JSON.stringify({ a: { t: "1" }, b: { t: "2" }, c: { t: "3" } }),
    );
    const { state, turn, stores } = daemonOver(storage(), 2);
    // Oldest (first-in-file) dropped; the two most-recent survive — and the
    // host hears the trim with the first turn, whatever it wrote.
    expect(state.get(A_2, "t")).toBeNull();
    turn(() => {});
    await stores.close();
    expect(Object.keys(onDisk())).toEqual(["b", "c"]);
  });

  it("clear() of the last key removes the session entirely (no empty husk)", async () => {
    const { turn, stores } = daemonOver(storage());
    turn((s) => {
      s.set(S1, "endcaps", "plain");
      s.clear(S1, "endcaps");
    });
    await stores.close();
    expect(onDisk()).toEqual({});
  });

  it("clear() promotes a surviving session so it isn't evicted early", async () => {
    const ss = new SessionState(undefined, 2);
    ss.set(A_2, "theme", "1");
    ss.set(A_2, "style", "x");
    ss.set(B, "theme", "2"); // order: a, b
    ss.clear(A_2, "style"); // "a" survives (still has theme) → promoted to b, a
    ss.set(C, "theme", "3"); // evicts the now-oldest "b", not "a"
    expect(ss.get(A_2, "theme")).toBe("1");
    expect(ss.get(B, "theme")).toBeNull();
  });

  it("a failed write keeps pending and retries on the next flush", async () => {
    // Parent of the target is a regular file, so mkdir/write/rename fails.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const badPath = join(blocker, "session-state.json");
    const session = new SessionFile(
      SESSION_STATE_FILE,
      badPath,
      systemTimekeeper,
      0,
    );
    session.save(new Map([[S1, { theme: "nord" }]]));
    // The write fails; the snapshot must NOT be dropped.
    await expect(session.flush()).rejects.toThrow(/EEXIST/);
    expect(existsSync(badPath)).toBe(false);
    // Make the path writable, then flush again — the retained snapshot lands.
    rmSync(blocker);
    await session.flush();
    const onDisk = JSON.parse(readFileSync(badPath, "utf8"));
    expect(onDisk.s1.theme).toBe("nord");
  });

  it("writes the state file with owner-only (no group/other) permissions", async () => {
    const session = storage();
    session.save(new Map([[S1, { theme: "nord" }]]));
    await session.flush();
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  // [LAW:behavior-not-structure] No save writes a `__proto__` key, so this
  // file is written by hand.
  it("a __proto__ key is dropped by name and pollutes nothing", async () => {
    writeFileSync(
      file,
      '{"__proto__": {"theme": "evil"}, "s1": {"theme": "nord"}}',
    );
    const logged: string[] = [];
    const loaded = storage((_level, line) => logged.push(line)).load();
    expect([...loaded]).toEqual([[S1, { theme: "nord" }]]);
    expect(({} as Record<string, unknown>)["theme"]).toBeUndefined();
    expect(logged).toContainEqual(
      'session-state load: dropped session key "__proto__": session id is "__proto__", which is never a session id',
    );
  });

  // [LAW:nothing-unseen] Every load says what it found, so a missing file
  // and a full one are told apart.
  it("each load says whether there was a file, and what it loaded and dropped", () => {
    const logged: string[] = [];
    const log = (_level: string, line: string): void => void logged.push(line);
    storage(log).load();
    writeFileSync(
      file,
      JSON.stringify({ s1: { theme: "nord" }, s2: { theme: 42 } }),
    );
    storage(log).load();
    expect(logged).toEqual([
      "session-state load: no file, starting empty",
      'session-state load: dropped session "s2": its value has a "theme" that is not a string',
      "session-state loaded sessions=1 dropped=1",
    ]);
  });

  // [LAW:no-silent-failure] Only the file's JSON is read as corrupt: a throw
  // past it is a bug, and reaches the caller.
  it("a throw past the JSON parse is thrown, never read as a corrupt file", () => {
    writeFileSync(file, JSON.stringify({ s1: { theme: "nord" } }));
    const logged: string[] = [];
    const throwing = new SessionFile(
      {
        ...SESSION_STATE_FILE,
        parse: () => {
          throw new Error("a bug in the parse");
        },
      },
      file,
      systemTimekeeper,
      0,
      (_level, line) => logged.push(line),
    );
    expect(() => throwing.load()).toThrow("a bug in the parse");
    expect(logged.join("\n")).not.toMatch(/corrupt JSON/);
  });
});
