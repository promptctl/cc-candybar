import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
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

  it("over-cap file is trimmed on hydrate", () => {
    writeFileSync(
      file,
      JSON.stringify({ a: { t: "1" }, b: { t: "2" }, c: { t: "3" } }),
    );
    const ss = new SessionState(new FileSessionStorage(file), 2);
    // Oldest (first-in-file) dropped; the two most-recent survive.
    expect(ss.get("a", "t")).toBeNull();
    expect(ss.get("b", "t")).toBe("2");
    expect(ss.get("c", "t")).toBe("3");
  });
});
