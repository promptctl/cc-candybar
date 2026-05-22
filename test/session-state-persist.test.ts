import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionState } from "../src/daemon/session-state";
import { FileSessionStorage } from "../src/daemon/session-state-file";

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

  it("survives a daemon restart: a fresh instance reads identical values", () => {
    const first = new SessionState(new FileSessionStorage(file, 0));
    first.set("s1", "theme", "dracula");
    first.set("s1", "displayStyle", "capsule");
    first.set("s2", "toolbar-expanded", "1");
    first.flush();

    const reborn = new SessionState(new FileSessionStorage(file));
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

    const reborn = new SessionState(new FileSessionStorage(file));
    expect(reborn.get("s1", "toolbar-expanded")).toBeNull();
  });

  it("prune() drops inactive sessions and persists the bounded set", () => {
    const first = new SessionState(new FileSessionStorage(file, 0));
    first.set("s1", "theme", "nord");
    first.set("s2", "theme", "dracula");
    first.flush();
    first.prune(new Set(["s1"]));
    first.flush();

    const reborn = new SessionState(new FileSessionStorage(file));
    expect(reborn.get("s1", "theme")).toBe("nord");
    expect(reborn.get("s2", "theme")).toBeNull();
  });

  it("debounces: no write until flush, then one atomic file", () => {
    jest.useFakeTimers();
    try {
      const ss = new SessionState(new FileSessionStorage(file, 500));
      ss.set("s1", "theme", "nord");
      ss.set("s1", "style", "muted");
      expect(existsSync(file)).toBe(false);

      jest.advanceTimersByTime(500);
      expect(existsSync(file)).toBe(true);
      expect(existsSync(`${file}.tmp`)).toBe(false);

      const reborn = new SessionState(new FileSessionStorage(file));
      expect(reborn.get("s1", "theme")).toBe("nord");
      expect(reborn.get("s1", "style")).toBe("muted");
    } finally {
      jest.useRealTimers();
    }
  });

  it("corrupt file hydrates to empty state, not a throw", () => {
    writeFileSync(file, "{ not valid json");
    const ss = new SessionState(new FileSessionStorage(file));
    expect(ss.get("s1", "theme")).toBeNull();
  });

  it("wrong-shape file hydrates to empty state", () => {
    writeFileSync(file, JSON.stringify({ s1: { theme: 42 } }));
    const ss = new SessionState(new FileSessionStorage(file));
    expect(ss.get("s1", "theme")).toBeNull();
  });

  it("missing file hydrates to empty state", () => {
    const ss = new SessionState(new FileSessionStorage(file));
    expect(ss.get("s1", "theme")).toBeNull();
  });

  it("bounds the store: oldest idle session is evicted past the cap", () => {
    const ss = new SessionState(new FileSessionStorage(file, 0), 2);
    ss.set("a", "theme", "1");
    ss.set("b", "theme", "2");
    ss.set("c", "theme", "3"); // pushes "a" out
    expect(ss.get("a", "theme")).toBeNull();
    expect(ss.get("b", "theme")).toBe("2");
    expect(ss.get("c", "theme")).toBe("3");
  });

  it("get-promotion protects an actively-read session from eviction", () => {
    const ss = new SessionState(new FileSessionStorage(file, 0), 2);
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
    const ss = new SessionState(new FileSessionStorage(file, 0), 2);
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

  it("a __proto__ sessionId does not pollute Object.prototype and round-trips as data", () => {
    const ss = new SessionState(new FileSessionStorage(file, 0));
    ss.set("__proto__", "theme", "evil");
    ss.flush();
    // Object.prototype untouched — no pollution.
    expect(({} as Record<string, unknown>)["theme"]).toBeUndefined();
    // The malicious key survives as ordinary stored data.
    const reborn = new SessionState(new FileSessionStorage(file));
    expect(reborn.get("__proto__", "theme")).toBe("evil");
  });
});
