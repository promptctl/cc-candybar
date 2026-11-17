// A session's picks across a restart: the renderer's session state drained as
// `store` writes at a turn's end, the host's profile writing them behind, and
// the next start's restore reading them back through the session owner's
// checks. The renderer opens no file; the profile is the one that does.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionState } from "../src/renderer/session-state";
import { StoredRegistry } from "../src/renderer/stored-registry";
import { sessionOwner } from "../src/renderer/stored-owners";
import { profileStore, type ProfileStore } from "../src/daemon/profile-store";
import type { Effect } from "../src/renderer-interface/interface";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { heldClock } from "./helpers/held-clock";
import { jestTmpDir } from "./helpers/jest-tmp";

const S1 = sessionIdOf("s1");
const S2 = sessionIdOf("s2");
const A = sessionIdOf("a");
const B = sessionIdOf("b");
const C = sessionIdOf("c");
const __PROTO__ = sessionIdOf("__proto__");

let dir: string;

beforeEach(() => {
  dir = jestTmpDir("state");
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sessionFile = () => join(dir, "session-state.json");
const onDisk = (): Record<string, unknown> =>
  JSON.parse(readFileSync(sessionFile(), "utf8")) as Record<string, unknown>;

// One daemon's life over the profile: its renderer started with what the
// profile holds, each `turn` ending as an event turn does, with its writes
// applied in the host's slot, and the daemon's close.
function started(maxSessions?: number) {
  const logged: string[] = [];
  const profile: ProfileStore = profileStore(
    dir,
    heldClock(new Date()),
    () => {},
    () => {},
  );
  profile.load();
  const state = new SessionState(maxSessions);
  const registry = new StoredRegistry([
    sessionOwner(state, (_level, line) => logged.push(line)),
  ]);
  registry.restore(profile.stored());
  const turn = (act: () => void = () => {}): Effect[] => {
    act();
    const effects: Effect[] = [];
    registry.drain(effects);
    for (const effect of effects)
      if (effect.kind === "store") profile.apply(effect);
    return effects;
  };
  return { state, turn, logged, close: () => profile.close() };
}

describe("a session's picks survive a restart", () => {
  test("a fresh renderer reads identical values", () => {
    const first = started();
    first.turn(() => {
      first.state.set(S1, "theme", "dracula");
      first.state.set(S1, "displayStyle", "capsule");
      first.state.set(S2, "endcaps", "plain");
    });
    first.close();

    const { state } = started();
    expect(state.get(S1, "theme")).toBe("dracula");
    expect(state.get(S1, "displayStyle")).toBe("capsule");
    expect(state.get(S2, "endcaps")).toBe("plain");
  });

  test("a turn that moved nothing writes nothing", () => {
    const { state, turn } = started();
    turn(() => state.set(S1, "theme", "nord"));
    expect(turn(() => state.get(S1, "theme"))).toEqual([]);
  });

  test("clear() of the last key takes the session away, across a restart", () => {
    const first = started();
    first.turn(() => first.state.set(S1, "endcaps", "plain"));
    const written = first.turn(() => first.state.clear(S1, "endcaps"));
    expect(written).toEqual([
      { kind: "store", store: "session", key: S1, value: null },
    ]);
    first.close();
    expect(onDisk()).toEqual({});
    expect(started().state.get(S1, "endcaps")).toBeNull();
  });

  test("prune() drops inactive sessions, across a restart", () => {
    const first = started();
    first.turn(() => {
      first.state.set(S1, "theme", "nord");
      first.state.set(S2, "theme", "dracula");
    });
    first.turn(() => first.state.prune(new Set([S1])));
    first.close();

    const { state } = started();
    expect(state.get(S1, "theme")).toBe("nord");
    expect(state.get(S2, "theme")).toBeNull();
  });

  test("a __proto__ session does not pollute Object.prototype and round-trips as data", () => {
    const first = started();
    first.turn(() => first.state.set(__PROTO__, "theme", "evil"));
    first.close();
    expect(({} as Record<string, unknown>)["theme"]).toBeUndefined();
    expect(started().state.get(__PROTO__, "theme")).toBe("evil");
  });
});

describe("what a restore drops is written back as gone", () => {
  test("sessions past the bound are trimmed at the start, and the trim lands on disk", () => {
    writeFileSync(
      sessionFile(),
      JSON.stringify({ a: { t: "1" }, b: { t: "2" }, c: { t: "3" } }),
    );
    const { state, turn, close } = started(2);
    // Oldest (first in the file) dropped; the two most recent survive, and
    // the first turn's end tells the host so with no other change.
    expect(state.get(A, "t")).toBeNull();
    expect(turn()).toEqual([
      { kind: "store", store: "session", key: A, value: null },
    ]);
    close();
    expect(Object.keys(onDisk()).sort()).toEqual([B, C]);
  });

  // [LAW:parse-dont-validate] The stored keys cross the session id checkpoint
  // on restore: a refused key is reported and dropped, and the sessions beside
  // it load whole.
  test("a stored key the session id checkpoint refuses is reported and not loaded", () => {
    writeFileSync(
      sessionFile(),
      JSON.stringify({ "a/b": { theme: "nord" }, [S1]: { theme: "dracula" } }),
    );
    const { state, turn, logged, close } = started();
    expect(state.get(S1, "theme")).toBe("dracula");
    expect(state.size()).toBe(1);
    expect(logged).toContainEqual(
      expect.stringMatching(
        /^session-state: dropped session key "a\/b": session id contains a path separator/,
      ),
    );
    turn();
    close();
    expect(onDisk()).toEqual({ [S1]: { theme: "dracula" } });
  });

  test("a session whose values are not strings is dropped and said", () => {
    writeFileSync(sessionFile(), JSON.stringify({ s1: { theme: 42 } }));
    const { state, logged } = started();
    expect(state.get(S1, "theme")).toBeNull();
    expect(logged).toContainEqual(
      "session-state: dropped session s1: not its values",
    );
  });

  test("keys an older build kept of a session's origin are not restored", () => {
    writeFileSync(
      sessionFile(),
      JSON.stringify({
        s1: { theme: "nord", "render-origin": "{}", "client-hints": "{}" },
      }),
    );
    const { state, turn, close } = started();
    expect(state.values(S1)).toEqual({ theme: "nord" });
    turn();
    close();
    expect(onDisk()).toEqual({ s1: { theme: "nord" } });
  });
});

describe("a store whose file does not read", () => {
  test("a corrupt file starts empty, said, and the first write replaces it", () => {
    writeFileSync(sessionFile(), "{ not valid json");
    const { state, turn, logged, close } = started();
    expect(state.get(S1, "theme")).toBeNull();
    expect(logged).toContainEqual(
      expect.stringMatching(
        /^session-state: session-state\.json is not JSON: .*; starting empty$/,
      ),
    );
    turn(() => state.set(S1, "theme", "nord"));
    close();
    expect(onDisk()).toEqual({ s1: { theme: "nord" } });
  });

  test("a missing file starts empty, and says nothing", () => {
    const { state, logged } = started();
    expect(state.get(S1, "theme")).toBeNull();
    expect(logged).toEqual([]);
  });
});

describe("the session state's bound, in memory", () => {
  test("the oldest idle session is evicted past the cap", () => {
    const ss = new SessionState(2);
    ss.set(A, "theme", "1");
    ss.set(B, "theme", "2");
    ss.set(C, "theme", "3"); // pushes "a" out
    expect(ss.get(A, "theme")).toBeNull();
    expect(ss.get(B, "theme")).toBe("2");
    expect(ss.get(C, "theme")).toBe("3");
  });

  test("get-promotion protects an actively-read session from eviction", () => {
    const ss = new SessionState(2);
    ss.set(A, "theme", "1");
    ss.set(B, "theme", "2");
    ss.get(A, "theme"); // promote "a" to most-recent
    ss.set(C, "theme", "3"); // now "b" is oldest, not "a"
    expect(ss.get(A, "theme")).toBe("1");
    expect(ss.get(B, "theme")).toBeNull();
  });

  test("clear() of the last key removes the session entirely (no empty husk)", () => {
    const ss = new SessionState();
    ss.set(S1, "endcaps", "plain");
    ss.clear(S1, "endcaps");
    expect(ss.size()).toBe(0);
    expect(ss.versions().has(S1)).toBe(false);
  });

  test("clear() promotes a surviving session so it isn't evicted early", () => {
    const ss = new SessionState(2);
    ss.set(A, "theme", "1");
    ss.set(A, "style", "x");
    ss.set(B, "theme", "2"); // order: a, b
    ss.clear(A, "style"); // "a" survives (still has theme) → promoted to b, a
    ss.set(C, "theme", "3"); // evicts the now-oldest "b", not "a"
    expect(ss.get(A, "theme")).toBe("1");
    expect(ss.get(B, "theme")).toBeNull();
  });
});
