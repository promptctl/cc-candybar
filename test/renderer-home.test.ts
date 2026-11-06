// A renderer's home (src/daemon/home.ts) and what derives from it
// (src/daemon/paths.ts): the name grammar, the parse of the two variables, and
// the main home's derivations against today's paths, side by side.

import path from "node:path";

import {
  HOME_ENV,
  NAME_ENV,
  RUNTIME_DIR_ENV,
  homeOf,
  parseRendererName,
  socketFile,
  uidRuntimeDir,
} from "../src/daemon/home";
import {
  cacheDir,
  configDir,
  daemonPaths,
  defaultSocketPath,
  homeEnv,
  socketPath,
  stateDir,
} from "../src/daemon/paths";
import { hostOf } from "./helpers/host";

// [LAW:one-source-of-truth] The grammar's vectors, the same lists as the Rust
// client's test module (rust-client/src/main.rs), diffed by
// scripts/check-protocol.mjs: each side drives its own parser from its own list.
const NAME_ACCEPT = [
  "a",
  "0",
  "w1",
  "dev-bar",
  "a-",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
];
const NAME_REJECT = [
  "",
  "main",
  "A",
  "Dev",
  "-a",
  "a_b",
  "a.b",
  "a b",
  " a",
  "é",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
];

// The home's parse, as `root|name|socket=outcome`: an empty field is the
// variable unset or empty, which read alike. Same list as the Rust client's.
const HOME_CASES = [
  "/r|n|=named",
  "||=main",
  "||/s=main",
  "/r||=refused",
  "|n|=refused",
  "/r|n|/s=refused",
  "r|n|=refused",
  "/r|main|=refused",
];

describe("a renderer's name", () => {
  test("the grammar accepts and refuses its vectors", () => {
    for (const name of NAME_ACCEPT) expect(parseRendererName(name)).toBe(name);
    for (const name of NAME_REJECT) {
      expect(() => parseRendererName(name)).toThrow(NAME_ENV);
    }
  });

  test("a socket file is the name's: main's stays `socket`, any other carries the suffix", () => {
    expect(socketFile("main")).toBe("socket");
    expect(socketFile(parseRendererName("dev-bar"))).toBe("dev-bar.sock");
  });
});

describe("the home a process is started with", () => {
  const parse = (root: string, name: string, socket: string) =>
    homeOf(hostOf({ [HOME_ENV]: root, [NAME_ENV]: name, CC_CANDYBAR_SOCKET: socket }, { home: "/u" }));

  test("both variables, neither, one, a relative root, the socket beside the pair", () => {
    for (const line of HOME_CASES) {
      const [inputs, outcome] = line.split("=") as [string, string];
      const [root, name, socket] = inputs.split("|").concat("", "") as [string, string, string];
      let got: string;
      try {
        got = parse(root, name, socket).kind;
      } catch {
        got = "refused";
      }
      expect(`${line} -> ${got}`).toBe(`${line} -> ${outcome}`);
    }
  });

  test("a refusal names the missing variable, the rule a name broke, and the override to unset", () => {
    expect(() => parse("/r", "", "")).toThrow(`${HOME_ENV} is set without ${NAME_ENV}`);
    expect(() => parse("", "n", "")).toThrow(`${NAME_ENV} is set without ${HOME_ENV}`);
    expect(() => parse("r", "n", "")).toThrow(`${HOME_ENV} must be an absolute path`);
    expect(() => parse("/r", "main", "")).toThrow(`${NAME_ENV} may not be "main"`);
    expect(() => parse("/r", "A", "")).toThrow(`${NAME_ENV} must be lowercase`);
    expect(() => parse("/r", "n", "/s")).toThrow("CC_CANDYBAR_SOCKET is set beside");
  });

  test("the runtime directory is the uid's unless the host overrides it", () => {
    expect(homeOf(hostOf({}, { home: "/u" })).runtime).toBe(uidRuntimeDir());
    expect(homeOf(hostOf({ [RUNTIME_DIR_ENV]: "/run" }, { home: "/u" })).runtime).toBe("/run");
    expect(() => homeOf(hostOf({ [RUNTIME_DIR_ENV]: "run" }, { home: "/u" }))).toThrow(
      `${RUNTIME_DIR_ENV} must be an absolute path`,
    );
  });
});

// [LAW:one-source-of-truth] The main home derives exactly today's paths, so an
// installed user, the Rust client and the URL handler see no change: listed
// side by side with the literal paths, for a host with XDG overrides and one
// without.
describe("the main home is today's layout", () => {
  const withoutXdg = homeOf(hostOf({}, { home: "/home/u" }));
  const withXdg = homeOf(
    hostOf(
      { XDG_STATE_HOME: "/x/state", XDG_CACHE_HOME: "/x/cache", XDG_CONFIG_HOME: "/x/config" },
      { home: "/home/u" },
    ),
  );
  const runtime = uidRuntimeDir();

  test("without XDG overrides", () => {
    expect(withoutXdg.kind).toBe("main");
    expect({
      ...daemonPaths(withoutXdg),
      cache: cacheDir(withoutXdg),
      config: configDir(withoutXdg),
    }).toEqual({
      socket: `${runtime}/socket`,
      lease: `${runtime}/socket.lease`,
      state: "/home/u/.local/state/cc-candybar",
      log: "/home/u/.local/state/cc-candybar/daemon.log",
      sessionState: "/home/u/.local/state/cc-candybar/session-state.json",
      settingsHistory: "/home/u/.local/state/cc-candybar/settings-history.json",
      storedRoot: "/home/u/.config/cc-candybar",
      watchProbe: "/home/u/.local/state/cc-candybar/watch-probe",
      spawnBackoff: "/home/u/.local/state/cc-candybar/spawn.backoff",
      cache: "/home/u/.cache/cc-candybar",
      config: "/home/u/.config/cc-candybar",
    });
    expect(socketPath(withoutXdg)).toBe(defaultSocketPath());
  });

  test("with XDG overrides", () => {
    expect({
      ...daemonPaths(withXdg),
      cache: cacheDir(withXdg),
      config: configDir(withXdg),
    }).toEqual({
      socket: `${runtime}/socket`,
      lease: `${runtime}/socket.lease`,
      state: "/x/state/cc-candybar",
      log: "/x/state/cc-candybar/daemon.log",
      sessionState: "/x/state/cc-candybar/session-state.json",
      settingsHistory: "/x/state/cc-candybar/settings-history.json",
      storedRoot: "/x/config/cc-candybar",
      watchProbe: "/x/state/cc-candybar/watch-probe",
      spawnBackoff: "/x/state/cc-candybar/spawn.backoff",
      cache: "/x/cache/cc-candybar",
      config: "/x/config/cc-candybar",
    });
  });

  test("an empty XDG variable means the default, as it does for every XDG variable", () => {
    const empty = homeOf(hostOf({ XDG_STATE_HOME: "" }, { home: "/home/u" }));
    expect(stateDir(empty)).toBe("/home/u/.local/state/cc-candybar");
  });

  test("the legacy socket override is honoured as main's socket, for one release", () => {
    const legacy = homeOf(hostOf({ CC_CANDYBAR_SOCKET: "/tmp/dev/s" }, { home: "/home/u" }));
    expect(socketPath(legacy)).toBe("/tmp/dev/s");
    expect(daemonPaths(legacy).lease).toBe("/tmp/dev/s.lease");
  });
});

describe("a named home", () => {
  const home = homeOf(
    hostOf({ [HOME_ENV]: "/w/home", [NAME_ENV]: "dev-bar", [RUNTIME_DIR_ENV]: "/w/run" }, { home: "/home/u" }),
  );

  test("keeps every path under its root, and its socket beside main's in the runtime directory", () => {
    expect(home.kind).toBe("named");
    const paths = daemonPaths(home);
    expect(paths.socket).toBe("/w/run/dev-bar.sock");
    expect(paths.lease).toBe("/w/run/dev-bar.sock.lease");
    const { socket: _s, lease: _l, storedRoot, ...underRoot } = paths;
    expect(storedRoot).toBe("/w/home");
    for (const p of [...Object.values(underRoot), cacheDir(home), configDir(home)]) {
      expect(p.startsWith("/w/home/")).toBe(true);
    }
    expect(stateDir(home)).toBe("/w/home/state");
    expect(cacheDir(home)).toBe("/w/home/cache");
    expect(configDir(home)).toBe("/w/home/config");
  });

  test("reads no XDG directory", () => {
    const xdg = homeOf(
      hostOf(
        { [HOME_ENV]: "/w/home", [NAME_ENV]: "dev-bar", XDG_CONFIG_HOME: "/x/config", XDG_STATE_HOME: "/x/state" },
        { home: "/home/u" },
      ),
    );
    expect(configDir(xdg)).toBe("/w/home/config");
    expect(stateDir(xdg)).toBe("/w/home/state");
  });
});

// The environment a renderer hands a child it starts parses the identical
// home: the inputs stated whole, those that do not apply stated empty.
describe("a child a renderer starts", () => {
  const roundTrip = (env: NodeJS.ProcessEnv) => {
    const home = homeOf(hostOf(env, { home: "/home/u" }));
    const child = homeOf(hostOf({ ...env, ...homeEnv(home) }, { home: "/home/u" }));
    return { home, child };
  };

  test("under a named home, parses that home whatever its shell carried", () => {
    const { home, child } = roundTrip({
      [HOME_ENV]: "/w/home",
      [NAME_ENV]: "dev-bar",
      [RUNTIME_DIR_ENV]: "/w/run",
    });
    expect(child).toEqual(home);
    // A shell that exported the override does not reach the child.
    const shell = { CC_CANDYBAR_SOCKET: "/tmp/dev/s", ...homeEnv(home) };
    expect(homeOf(hostOf(shell, { home: "/home/u" }))).toEqual(home);
  });

  test("under a canonical main, parses a canonical main: no bridge, no warning", () => {
    const { home, child } = roundTrip({});
    expect(child).toEqual(home);
    expect(child.kind === "main" && child.legacySocket).toBeNull();
    // A shell that exported a named home's pair does not reach the child.
    const shell = { [HOME_ENV]: "/other", [NAME_ENV]: "x", ...homeEnv(home) };
    expect(homeOf(hostOf(shell, { home: "/home/u" }))).toEqual(home);
  });

  test("under a main with XDG overrides, parses the same roots whatever the child's shell carried", () => {
    const { home, child } = roundTrip({
      XDG_STATE_HOME: "/x/state",
      XDG_CACHE_HOME: "/x/cache",
      XDG_CONFIG_HOME: "/x/config",
    });
    expect(child).toEqual(home);
    // A tmux server whose environment names other roots does not reach the child.
    const server = { XDG_STATE_HOME: "/srv", XDG_CONFIG_HOME: "/srv", ...homeEnv(home) };
    expect(homeOf(hostOf(server, { home: "/home/u" }))).toEqual(home);
  });

  test("under a main on the legacy override, passes the override through", () => {
    const { home, child } = roundTrip({ CC_CANDYBAR_SOCKET: "/tmp/dev/s" });
    expect(child).toEqual(home);
    expect(socketPath(child)).toBe("/tmp/dev/s");
  });

  test("under a main in a test's runtime directory, derives the same socket", () => {
    const { home, child } = roundTrip({ [RUNTIME_DIR_ENV]: "/w/run" });
    expect(socketPath(child)).toBe(socketPath(home));
    expect(socketPath(child)).toBe(path.join("/w/run", "socket"));
  });
});
