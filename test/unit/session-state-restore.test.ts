import { autorun } from "mobx";
import {
  SessionState,
  type SessionSnapshot,
  type SessionStorage,
  SINGLE_RUN,
} from "../../src/daemon/session-state";

const holding = (snapshot: SessionSnapshot): SessionStorage => ({
  load: () => snapshot,
  save: () => {},
  flush: () => {},
});

test("a restore makes the session hold another store's values at that store's revision", () => {
  const store = new SessionState(SINGLE_RUN);
  store.set("s1", "preset", "nord");
  store.set("s1", "settings.menu", "open");
  store.restore("s1", { preset: "dracula" }, 40);
  expect(store.values("s1")).toEqual({ preset: "dracula" });
  expect(store.revision("s1")).toBe(40);
});

test("a restore to no values holds nothing for the session, at revision 0", () => {
  const store = new SessionState(SINGLE_RUN);
  store.set("s1", "preset", "nord");
  store.restore("s1", {}, 0);
  expect(store.values("s1")).toEqual({});
  expect(store.revision("s1")).toBe(0);
});

test("a write after a restore mints a revision above the restored one, and moves the session", () => {
  const store = new SessionState(SINGLE_RUN);
  store.restore("s1", { preset: "nord" }, 40);
  store.set("s2", "preset", "dracula");
  expect(store.revision("s2")).toBeGreaterThan(40);
  store.set("s1", "preset", "dracula");
  expect(store.revision("s1")).toBeGreaterThan(store.revision("s2"));
});

test("a restore to the revision the session holds notifies nothing", () => {
  const store = new SessionState(SINGLE_RUN);
  store.restore("s1", { preset: "nord" }, 40);
  let runs = 0;
  const stop = autorun(() => {
    store.revision("s1");
    runs++;
  });
  store.restore("s1", { preset: "nord" }, 40);
  expect(runs).toBe(1);
  store.restore("s1", { preset: "dracula" }, 41);
  expect(runs).toBe(2);
  stop();
});

test("a session the file holds empty is not taken up: it reads no values at revision 0", () => {
  const store = new SessionState(SINGLE_RUN, holding({ husk: {}, s1: { preset: "nord" } }));
  expect(store.values("husk")).toEqual({});
  expect(store.revision("husk")).toBe(0);
  expect(store.values("s1")).toEqual({ preset: "nord" });
  expect(store.revision("s1")).toBeGreaterThan(0);
});
