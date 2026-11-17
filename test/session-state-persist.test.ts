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
} from "../src/daemon/session-state-file";
import type { SessionStorage } from "../src/renderer-interface/session-state";
import {
  EPHEMERAL_HISTORY_STORAGE,
  HeldStores,
} from "../src/daemon/held-stores";
import { emptyStores } from "./helpers/doctor-facts";
import { throughout, until } from "./helpers/until";
import { systemTimekeeper } from "../src/time";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const S1 = sessionIdOf("s1");
const S2 = sessionIdOf("s2");
const A_2 = sessionIdOf("a");
const B = sessionIdOf("b");
const C = sessionIdOf("c");
const __PROTO__ = sessionIdOf("__proto__");

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
  const daemonOver = (session: SessionStorage, maxSessions?: number) => {
    const stores = new HeldStores(
      { session, history: EPHEMERAL_HISTORY_STORAGE, doctor: emptyStores() },
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
  const restarted = (maxSessions?: number) => {
    const daemon = daemonOver(storage(), maxSessions);
    daemon.stores.close();
    return daemon.state;
  };

  // [LAW:no-ambient-temporal-coupling] What lands after a daemon closed stays
  // in memory: a late write can't land over the file a next daemon took up.
  it("a write after close reaches memory and not the file", () => {
    const session = storage();
    const { state, turn, stores } = daemonOver(session);
    turn((s) => s.set(S1, "theme", "nord"));
    stores.close();
    const closedWith = readFileSync(file, "utf8");
    expect(JSON.parse(closedWith)).toEqual({ s1: { theme: "nord" } });

    turn((s) => s.set(S1, "theme", "dracula"));
    expect(state.get(S1, "theme")).toBe("dracula");
    expect(stores.current().sessions[S1]).toEqual({ theme: "dracula" });
    session.flush();
    expect(readFileSync(file, "utf8")).toBe(closedWith);
  });

  // [LAW:nothing-unseen] A flush blocks the daemon's one thread, so each one
  // says what it wrote and how long it held the thread.
  it("each flush logs the bytes and sessions it wrote and how long it took", () => {
    const logged: string[] = [];
    const session = storage((_level, line) => logged.push(line));
    session.save({ [S1]: { theme: "dracula" } });
    session.flush();
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
  it("a stored key the session id checkpoint refuses is reported and not loaded", () => {
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
    storage((_level, line) => logged.push(line)).save({
      [S1]: { theme: "nord" },
    });
    await settled(() =>
      logged.some((l) => l.startsWith("session-state saved")),
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      s1: { theme: "nord" },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.writing`)).toBe(false);
  });

  // The rename that publishes a debounced write runs on the thread pool, so a
  // flush can land while it is on its way. The newer state still wins, the
  // older write's temp file is gone, and nothing calls the superseded rename
  // a failure.
  it("a synchronous flush while the debounced rename is in flight keeps the newer state", async () => {
    const logged: string[] = [];
    const session = storage((_level, line) => logged.push(line));
    const rename = fs.promises.rename;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = jest
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (from, to) => {
        await held;
        return rename(from, to);
      });
    try {
      session.save({ [S1]: { theme: "old" } });
      await settled(() => spy.mock.calls.length === 1);
      session.save({ [S1]: { theme: "new" } });
      session.flush();
      release();
      // The held rename runs out: it finds no temp file, and the write ends.
      await settled(() => logged.some((l) => l.includes("superseded")));
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      s1: { theme: "new" },
    });
    expect(existsSync(`${file}.writing`)).toBe(false);
    expect(logged.filter((l) => l.includes("save failed"))).toEqual([]);
    expect(logged.filter((l) => l.includes("superseded"))).toEqual([
      expect.stringContaining("superseded by a flush landed=false"),
    ]);
  });

  // A flush the disk refuses supersedes nothing: the debounced write it raced
  // still publishes, and the flush's newer state waits for the next save.
  it("a synchronous flush the disk refuses leaves the in-flight write to land", async () => {
    const logged: string[] = [];
    // A real debounce: the newer state the failed flush leaves pending is
    // rescheduled once the raced write lands, and must not land before the
    // file is read back.
    const session = new SessionFile(
      SESSION_STATE_FILE,
      file,
      systemTimekeeper,
      500,
      (_level, line) => logged.push(line),
    );
    const rename = fs.promises.rename;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const renameSpy = jest
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (from, to) => {
        await held;
        return rename(from, to);
      });
    const writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC" });
    });
    try {
      session.save({ [S1]: { theme: "old" } });
      await settled(() => renameSpy.mock.calls.length === 1);
      session.save({ [S1]: { theme: "new" } });
      session.flush();
      release();
      await settled(() => logged.some((l) => l.includes("saved")));
    } finally {
      writeSpy.mockRestore();
      renameSpy.mockRestore();
    }
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      s1: { theme: "old" },
    });
    expect(logged.filter((l) => l.includes("save failed"))).toHaveLength(1);
    expect(logged.filter((l) => l.includes("superseded"))).toEqual([]);
    expect(logged.filter((l) => l.includes("saved"))).toHaveLength(1);
    // The newer state is still pending: the next flush lands it.
    session.flush();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      s1: { theme: "new" },
    });
    expect(logged.filter((l) => l.includes("saved"))).toHaveLength(2);
  });

  // [LAW:no-ambient-temporal-coupling] Shutdown's synchronous flush writes the
  // newest state; a debounced write already on its way is older, and must not
  // land over it. Here the flush lands before that write reaches its rename:
  // the write removes its own temp file and says it was superseded.
  it("a synchronous flush before the debounced rename supersedes it", async () => {
    const logged: string[] = [];
    const session = storage((_level, line) => logged.push(line));
    const mkdir = fs.promises.mkdir;
    const spy = jest
      .spyOn(fs.promises, "mkdir")
      .mockImplementation(async (dir, opts) => {
        // The write's first await: the flush lands before it resumes.
        session.save({ [S1]: { theme: "new" } });
        session.flush();
        return mkdir(dir, opts);
      });
    try {
      session.save({ [S1]: { theme: "old" } });
      await settled(() => logged.some((l) => l.includes("superseded")));
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      s1: { theme: "new" },
    });
    expect(existsSync(`${file}.writing`)).toBe(false);
    expect(logged.filter((l) => l.includes("save failed"))).toEqual([]);
    expect(logged.filter((l) => l.includes("superseded"))).toEqual([
      expect.stringContaining("superseded by a flush landed=false"),
    ]);
  });

  // The other ordering: the debounced rename lands, and the flush writes over
  // it before the write resumes. The write says it was superseded rather than
  // `saved` after the flush's own line, and the flush's state stands.
  it("a synchronous flush right after the debounced rename lands supersedes it", async () => {
    const logged: string[] = [];
    const session = storage((_level, line) => logged.push(line));
    const rename = fs.promises.rename;
    const spy = jest
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (from, to) => {
        await rename(from, to);
        // On disk, but the write has not resumed: the flush lands in between.
        session.save({ [S1]: { theme: "new" } });
        session.flush();
      });
    try {
      session.save({ [S1]: { theme: "old" } });
      await settled(() => logged.some((l) => l.includes("superseded")));
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      s1: { theme: "new" },
    });
    expect(logged.filter((l) => l.includes("save failed"))).toEqual([]);
    expect(logged.filter((l) => l.includes("superseded"))).toEqual([
      expect.stringContaining("superseded by a flush landed=true"),
    ]);
    // The flush's `saved` is the last one.
    expect(logged.filter((l) => l.includes("saved")).length).toBe(1);
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
    ).save({ [S1]: { theme: "nord" } });
    await settled(() => logged.some((l) => l.includes("save failed")));
    await throughout(
      () => logged.filter((l) => l.includes("save failed")).length === 1,
      "one failed write, not retried",
      100,
    );
  });

  it("survives a daemon restart: a fresh instance reads identical values", () => {
    const first = daemonOver(storage());
    first.turn((s) => s.set(S1, "theme", "dracula"));
    first.turn((s) => s.set(S1, "displayStyle", "capsule"));
    first.turn((s) => s.set(S2, "endcaps", "plain"));
    first.stores.close();

    const reborn = restarted();
    expect(reborn.get(S1, "theme")).toBe("dracula");
    expect(reborn.get(S1, "displayStyle")).toBe("capsule");
    expect(reborn.get(S2, "endcaps")).toBe("plain");
  });

  it("clear() persists removal across a restart", () => {
    const first = daemonOver(storage());
    first.turn((s) => s.set(S1, "endcaps", "plain"));
    first.turn((s) => s.clear(S1, "endcaps"));
    first.stores.close();

    expect(restarted().get(S1, "endcaps")).toBeNull();
    expect(onDisk()).toEqual({});
  });

  // [LAW:types-are-the-program] Both copies are ordered by write, so the
  // file keeps the recency the renderer's bound evicts by.
  it("a restart keeps the order the sessions were last written in", () => {
    const first = daemonOver(storage());
    first.turn((s) => s.set(A_2, "t", "1"));
    first.turn((s) => s.set(B, "t", "2"));
    first.turn((s) => s.set(A_2, "t", "3"));
    first.stores.close();
    expect(Object.keys(onDisk())).toEqual(["b", "a"]);

    const reborn = restarted(2);
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
      session.save({ [S1]: { theme: "nord" } });
      session.save({ [S1]: { theme: "nord", style: "muted" } });
      jest.advanceTimersByTime(499);
      expect(existsSync(file)).toBe(false);

      // The window elapses; the write then reaches the disk off the thread.
      jest.advanceTimersByTime(1);
      jest.useRealTimers();
      await settled(() => existsSync(file));
      expect(existsSync(`${file}.writing`)).toBe(false);

      const reborn = restarted();
      expect(reborn.get(S1, "theme")).toBe("nord");
      expect(reborn.get(S1, "style")).toBe("muted");
    } finally {
      jest.useRealTimers();
    }
  });

  it("corrupt file hydrates to empty state, not a throw", () => {
    writeFileSync(file, "{ not valid json");
    const ss = restarted();
    expect(ss.get(S1, "theme")).toBeNull();
  });

  it("wrong-shape file hydrates to empty state", () => {
    writeFileSync(file, JSON.stringify({ s1: { theme: 42 } }));
    const ss = restarted();
    expect(ss.get(S1, "theme")).toBeNull();
  });

  it("missing file hydrates to empty state", () => {
    const ss = restarted();
    expect(ss.get(S1, "theme")).toBeNull();
  });

  it("bounds the store: oldest idle session is evicted past the cap", () => {
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
  it("a read does not protect a session from eviction", () => {
    const ss = new SessionState(undefined, 2);
    ss.set(A_2, "theme", "1");
    ss.set(B, "theme", "2");
    ss.get(A_2, "theme");
    ss.set(C, "theme", "3");
    expect(ss.get(A_2, "theme")).toBeNull();
    expect(ss.get(B, "theme")).toBe("2");
  });

  it("over-cap file is trimmed on hydrate and the trim is persisted to disk", () => {
    writeFileSync(
      file,
      JSON.stringify({ a: { t: "1" }, b: { t: "2" }, c: { t: "3" } }),
    );
    const { state, turn, stores } = daemonOver(storage(), 2);
    // Oldest (first-in-file) dropped; the two most-recent survive — and the
    // host hears the trim with the first turn, whatever it wrote.
    expect(state.get(A_2, "t")).toBeNull();
    turn(() => {});
    stores.close();
    expect(Object.keys(onDisk())).toEqual(["b", "c"]);
  });

  it("clear() of the last key removes the session entirely (no empty husk)", () => {
    const { turn, stores } = daemonOver(storage());
    turn((s) => {
      s.set(S1, "endcaps", "plain");
      s.clear(S1, "endcaps");
    });
    stores.close();
    expect(onDisk()).toEqual({});
  });

  it("clear() promotes a surviving session so it isn't evicted early", () => {
    const ss = new SessionState(undefined, 2);
    ss.set(A_2, "theme", "1");
    ss.set(A_2, "style", "x");
    ss.set(B, "theme", "2"); // order: a, b
    ss.clear(A_2, "style"); // "a" survives (still has theme) → promoted to b, a
    ss.set(C, "theme", "3"); // evicts the now-oldest "b", not "a"
    expect(ss.get(A_2, "theme")).toBe("1");
    expect(ss.get(B, "theme")).toBeNull();
  });

  it("a failed write keeps pending and retries on the next flush", () => {
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
    session.save({ [S1]: { theme: "nord" } });
    session.flush(); // write fails; snapshot must NOT be dropped
    expect(existsSync(badPath)).toBe(false);
    // Make the path writable, then flush again — the retained snapshot lands.
    rmSync(blocker);
    session.flush();
    const onDisk = JSON.parse(readFileSync(badPath, "utf8"));
    expect(onDisk.s1.theme).toBe("nord");
  });

  it("writes the state file with owner-only (no group/other) permissions", () => {
    const session = storage();
    session.save({ [S1]: { theme: "nord" } });
    session.flush();
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it("a __proto__ sessionId does not pollute Object.prototype and round-trips as data", () => {
    const first = daemonOver(storage());
    first.turn((s) => s.set(__PROTO__, "theme", "evil"));
    first.stores.close();
    // Object.prototype untouched — no pollution.
    expect(({} as Record<string, unknown>)["theme"]).toBeUndefined();
    // The malicious key survives as ordinary stored data.
    const reborn = restarted();
    expect(reborn.get(__PROTO__, "theme")).toBe("evil");
  });
});
