// brandon-client-hints-7ua: the `mementoEnv` client hint — what the client
// reports, what the daemon's checkpoint admits, and the environment memento's
// spawns get from it. The first table is the one the Rust client's
// memento_env_hint_reports_exactly_what_the_ts_client_reports pins, so the two
// runtimes report a session's variables alike.

import { detectMementoEnv } from "../src/memento-hint";
import { parseClientHints } from "../src/daemon/protocol";
import { ceilingScope, mementoEnv } from "../src/memento/edge";

const ANCHOR = { sessionId: "s1", projectDir: "/proj", cwd: "/proj/sub" };

test("the client reports each variable its environment sets, absolute against its cwd", () => {
  const hint = (home?: string, xdg?: string) =>
    detectMementoEnv({ MEMENTO_CONFIG_HOME: home, XDG_CONFIG_HOME: xdg }, "/work/proj");
  expect(hint()).toEqual({});
  expect(hint("", "")).toEqual({});
  expect(hint("/m")).toEqual({ MEMENTO_CONFIG_HOME: "/m" });
  expect(hint("/m", "cfg")).toEqual({
    MEMENTO_CONFIG_HOME: "/m",
    XDG_CONFIG_HOME: "/work/proj/cfg",
  });
});

test("the checkpoint keeps the three wire states apart and refuses a malformed hint whole", () => {
  const parsed = (v: unknown) => parseClientHints({ mementoEnv: v }).mementoEnv;
  expect(parseClientHints({}).mementoEnv).toBeUndefined();
  expect(parsed({})).toEqual({});
  expect(parsed({ XDG_CONFIG_HOME: "/x", PATH: "/evil" })).toEqual({ XDG_CONFIG_HOME: "/x" });
  for (const bad of [null, "x", ["/x"], { XDG_CONFIG_HOME: "rel" }, { MEMENTO_CONFIG_HOME: "/m", XDG_CONFIG_HOME: 7 }]) {
    expect(parsed(bad)).toBeUndefined();
  }
});

describe("the environment a memento spawn runs with", () => {
  // The daemon's own env: another session's variables, as a detached daemon's are.
  const DAEMON = {
    PATH: "/bin",
    MEMENTO_CONFIG_HOME: "/daemon/memento",
    XDG_CONFIG_HOME: "/daemon/xdg",
    CLAUDE_PROJECT_DIR: "/daemon/proj",
    CLAUDE_CODE_SESSION_ID: "daemon-session",
  };
  const envFor = (mementoEnvHint: unknown) =>
    mementoEnv(ceilingScope(ANCHOR, parseClientHints({ mementoEnv: mementoEnvHint })), DAEMON);

  test("a reporting client's variables replace the daemon's; one it does not set is dropped", () => {
    expect(envFor({ XDG_CONFIG_HOME: "/session/xdg" })).toEqual({
      PATH: "/bin",
      XDG_CONFIG_HOME: "/session/xdg",
      CLAUDE_PROJECT_DIR: "/proj",
      CLAUDE_CODE_SESSION_ID: "s1",
    });
    expect(envFor({})).toEqual({
      PATH: "/bin",
      CLAUDE_PROJECT_DIR: "/proj",
      CLAUDE_CODE_SESSION_ID: "s1",
    });
  });

  test("a client too old to report leaves the daemon's variables in place", () => {
    expect(envFor(undefined)).toEqual({
      PATH: "/bin",
      MEMENTO_CONFIG_HOME: "/daemon/memento",
      XDG_CONFIG_HOME: "/daemon/xdg",
      CLAUDE_PROJECT_DIR: "/proj",
      CLAUDE_CODE_SESSION_ID: "s1",
    });
  });
});
