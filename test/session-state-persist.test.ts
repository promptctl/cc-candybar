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
import { SessionState } from "../src/daemon/session-state";
import { FileSessionStorage } from "../src/daemon/session-state-file";
import { throughout, until } from "./helpers/until";

describe("SessionState disk persistence", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-state-test-"));
    file = join(dir, "session-state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Reader instance: load from disk, then flush so the constructor's
  // write-back fires synchronously rather than leaving a debounced timer that
  // could touch the filesystem after the temp dir is cleaned up.
  const restore = () => {
    const ss = new SessionState(new FileSessionStorage(file, 0));
    ss.flush();
    return ss;
  };

  it("the ephemeral default reads no file, and a file storage loads it at construction", () => {
    writeFileSync(file, JSON.stringify({ s1: { theme: "nord" } }));
    expect(new SessionState().get("s1", "theme")).toBeNull();
    expect(
      new SessionState(new FileSessionStorage(file, 0)).get("s1", "theme"),
    ).toBe("nord");
  });

  // [LAW:no-ambient-temporal-coupling] What lands after a daemon closed stays
  // in memory: a late write can't land over the file a next daemon took up.
  it("a write after close reaches memory and not the file", () => {
    const ss = new SessionState(new FileSessionStorage(file, 0));
    ss.set("s1", "theme", "nord");
    ss.close();
    const closedWith = readFileSync(file, "utf8");
    expect(JSON.parse(closedWith)).toEqual({ s1: { theme: "nord" } });

    ss.set("s1", "theme", "dracula");
    expect(ss.get("s1", "theme")).toBe("dracula");
    ss.flush();
    expect(readFileSync(file, "utf8")).toBe(closedWith);
  });

  // [LAW:nothing-unseen] A flush blocks the daemon's one thread, so each one
  // says what it wrote and how long it held the thread.
  it("each flush logs the bytes and sessions it wrote and how long it took", () => {
    const logged: string[] = [];
    const ss = new SessionState(
      new FileSessionStorage(file, 0, (_level, line) => logged.push(line)),
    );
    ss.set("s1", "theme", "dracula");
    ss.flush();
    const bytes = Buffer.byteLength(readFileSync(file, "utf8"));
    expect(logged.at(-1)).toMatch(
      new RegExp(
        `^session-state saved bytes=${bytes} sessions=1 took=\\d+ms held=\\d+ms$`,
      ),
    );
  });

  const settled = (done: () => boolean): Promise<void> =>
    until(done, "the write's landing");

  // The debounced write reaches the disk off the daemon's thread: no flush is
  // called, and the file still lands whole, owner-only.
  it("a debounced save lands on disk by itself and says so", async () => {
    const logged: string[] = [];
    const ss = new SessionState(
      new FileSessionStorage(file, 0, (_level, line) => logged.push(line)),
    );
    ss.set("s1", "theme", "nord");
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
    const ss = new SessionState(
      new FileSessionStorage(file, 0, (_level, line) => logged.push(line)),
    );
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
      ss.set("s1", "theme", "old");
      await settled(() => spy.mock.calls.length === 1);
      ss.set("s1", "theme", "new");
      ss.flush();
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
    const ss = new SessionState(
      new FileSessionStorage(file, 500, (_level, line) => logged.push(line)),
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
    const writeSpy = jest
      .spyOn(fs, "writeFileSync")
      .mockImplementation(() => {
        throw Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC" });
      });
    try {
      ss.set("s1", "theme", "old");
      await settled(() => renameSpy.mock.calls.length === 1);
      ss.set("s1", "theme", "new");
      ss.flush();
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
    ss.flush();
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
    const ss = new SessionState(
      new FileSessionStorage(file, 0, (_level, line) => logged.push(line)),
    );
    const mkdir = fs.promises.mkdir;
    const spy = jest
      .spyOn(fs.promises, "mkdir")
      .mockImplementation(async (dir, opts) => {
        // The write's first await: the flush lands before it resumes.
        ss.set("s1", "theme", "new");
        ss.flush();
        return mkdir(dir, opts);
      });
    try {
      ss.set("s1", "theme", "old");
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
    const ss = new SessionState(
      new FileSessionStorage(file, 0, (_level, line) => logged.push(line)),
    );
    const rename = fs.promises.rename;
    const spy = jest
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (from, to) => {
        await rename(from, to);
        // On disk, but the write has not resumed: the flush lands in between.
        ss.set("s1", "theme", "new");
        ss.flush();
      });
    try {
      ss.set("s1", "theme", "old");
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
    const ss = new SessionState(
      new FileSessionStorage(
        join(blocked, "session-state.json"),
        0,
        (_level, line) => logged.push(line),
      ),
    );
    ss.set("s1", "theme", "nord");
    await settled(() => logged.some((l) => l.includes("save failed")));
    await throughout(
      () => logged.filter((l) => l.includes("save failed")).length === 1,
      "one failed write, not retried",
      100,
    );
  });

  it("survives a daemon restart: a fresh instance reads identical values", () => {
    const first = new SessionState(new FileSessionStorage(file, 0));
    first.set("s1", "theme", "dracula");
    first.set("s1", "displayStyle", "capsule");
    first.set("s2", "toolbar-expanded", "1");
    first.flush();

    const reborn = restore();
    expect(reborn.get("s1", "theme")).toBe("dracula");
    expect(reborn.get("s1", "displayStyle")).toBe("capsule");
    expect(reborn.get("s2", "toolbar-expanded")).toBe("1");
  });

  it("clear() persists removal across a restart", () => {
    const first = new SessionState(new FileSessionStorage(file, 0));
    first.set("s1", "toolbar-expanded", "1");
    first.flush();
    first.clear("s1", "toolbar-expanded");
    first.flush();

    const reborn = restore();
    expect(reborn.get("s1", "toolbar-expanded")).toBeNull();
  });

  it("prune() drops inactive sessions and persists the bounded set", () => {
    const first = new SessionState(new FileSessionStorage(file, 0));
    first.set("s1", "theme", "nord");
    first.set("s2", "theme", "dracula");
    first.flush();
    first.prune(new Set(["s1"]));
    first.flush();

    const reborn = restore();
    expect(reborn.get("s1", "theme")).toBe("nord");
    expect(reborn.get("s2", "theme")).toBeNull();
  });

  it("debounces: no write before the window elapses, then one atomic file", async () => {
    jest.useFakeTimers();
    try {
      const ss = new SessionState(new FileSessionStorage(file, 500));
      ss.set("s1", "theme", "nord");
      ss.set("s1", "style", "muted");
      jest.advanceTimersByTime(499);
      expect(existsSync(file)).toBe(false);

      // The window elapses; the write then reaches the disk off the thread.
      jest.advanceTimersByTime(1);
      jest.useRealTimers();
      await settled(() => existsSync(file));
      expect(existsSync(`${file}.writing`)).toBe(false);

      const reborn = restore();
      expect(reborn.get("s1", "theme")).toBe("nord");
      expect(reborn.get("s1", "style")).toBe("muted");
    } finally {
      jest.useRealTimers();
    }
  });

  it("corrupt file hydrates to empty state, not a throw", () => {
    writeFileSync(file, "{ not valid json");
    const ss = restore();
    expect(ss.get("s1", "theme")).toBeNull();
  });

  it("wrong-shape file hydrates to empty state", () => {
    writeFileSync(file, JSON.stringify({ s1: { theme: 42 } }));
    const ss = restore();
    expect(ss.get("s1", "theme")).toBeNull();
  });

  it("missing file hydrates to empty state", () => {
    const ss = restore();
    expect(ss.get("s1", "theme")).toBeNull();
  });

  it("bounds the store: oldest idle session is evicted past the cap", () => {
    const ss = new SessionState(undefined, 2);
    ss.set("a", "theme", "1");
    ss.set("b", "theme", "2");
    ss.set("c", "theme", "3"); // pushes "a" out
    expect(ss.get("a", "theme")).toBeNull();
    expect(ss.get("b", "theme")).toBe("2");
    expect(ss.get("c", "theme")).toBe("3");
  });

  it("get-promotion protects an actively-read session from eviction", () => {
    const ss = new SessionState(undefined, 2);
    ss.set("a", "theme", "1");
    ss.set("b", "theme", "2");
    ss.get("a", "theme"); // promote "a" to most-recent
    ss.set("c", "theme", "3"); // now "b" is oldest, not "a"
    expect(ss.get("a", "theme")).toBe("1");
    expect(ss.get("b", "theme")).toBeNull();
  });

  it("over-cap file is trimmed on hydrate and the trim is persisted to disk", () => {
    writeFileSync(
      file,
      JSON.stringify({ a: { t: "1" }, b: { t: "2" }, c: { t: "3" } }),
    );
    const ss = new SessionState(new FileSessionStorage(file, 0), 2);
    ss.flush(); // force the constructor-scheduled write-back
    // Oldest (first-in-file) dropped; the two most-recent survive — and the
    // bound is enforced on disk without any post-restart mutation.
    expect(ss.get("a", "t")).toBeNull();
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(onDisk).sort()).toEqual(["b", "c"]);
  });

  it("clear() of the last key removes the session entirely (no empty husk)", () => {
    const ss = new SessionState(new FileSessionStorage(file, 0));
    ss.set("s1", "toolbar-expanded", "1");
    ss.clear("s1", "toolbar-expanded");
    ss.flush();
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.s1).toBeUndefined();
    expect(Object.keys(onDisk)).toHaveLength(0);
  });

  it("clear() promotes a surviving session so it isn't evicted early", () => {
    const ss = new SessionState(undefined, 2);
    ss.set("a", "theme", "1");
    ss.set("a", "style", "x");
    ss.set("b", "theme", "2"); // order: a, b
    ss.clear("a", "style"); // "a" survives (still has theme) → promoted to b, a
    ss.set("c", "theme", "3"); // evicts the now-oldest "b", not "a"
    expect(ss.get("a", "theme")).toBe("1");
    expect(ss.get("b", "theme")).toBeNull();
  });

  it("a failed write keeps pending and retries on the next flush", () => {
    // Parent of the target is a regular file, so mkdir/write/rename fails.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const badPath = join(blocker, "session-state.json");
    const ss = new SessionState(new FileSessionStorage(badPath, 0));
    ss.set("s1", "theme", "nord");
    ss.flush(); // write fails; snapshot must NOT be dropped
    expect(existsSync(badPath)).toBe(false);
    // Make the path writable, then flush again — the retained snapshot lands.
    rmSync(blocker);
    ss.flush();
    const onDisk = JSON.parse(readFileSync(badPath, "utf8"));
    expect(onDisk.s1.theme).toBe("nord");
  });

  it("writes the state file with owner-only (no group/other) permissions", () => {
    const ss = new SessionState(new FileSessionStorage(file, 0));
    ss.set("s1", "theme", "nord");
    ss.flush();
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it("a __proto__ sessionId does not pollute Object.prototype and round-trips as data", () => {
    const ss = new SessionState(new FileSessionStorage(file, 0));
    ss.set("__proto__", "theme", "evil");
    ss.flush();
    // Object.prototype untouched — no pollution.
    expect(({} as Record<string, unknown>)["theme"]).toBeUndefined();
    // The malicious key survives as ordinary stored data.
    const reborn = restore();
    expect(reborn.get("__proto__", "theme")).toBe("evil");
  });
});
