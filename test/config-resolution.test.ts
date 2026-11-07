// [LAW:single-enforcer] Tests for dsl-loader's path resolution and
// collision detection — the single enumerator (dslConfigCandidatePaths)
// feeds the resolver, the watcher, and the collision detector. Behavior
// under test:
//   - .json5 and .json are both accepted at every location
//   - .json5 wins over .json at the same location (documented > legacy)
//   - every location's file is a layer: XDG < cwd < project
//   - detectConfigCollisions surfaces same-location duplicates
//   - durableConfig names the user's file and the layers above it

import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { homeOf } from "../src/daemon/home";
import { locations, type Locations } from "../src/daemon/paths";
import { mainEnv, hostOf } from "./helpers/host";
import { NO_REPOS } from "./helpers/repo-gate";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveDslConfig,
  configResolutionNotice,
  durableConfig,
  dslConfigCandidatePaths,
  detectConfigCollisions,
} from "../src/config/dsl-loader";
import type { RepoAnswers } from "../src/config/loader/repo-gate";

// The answers with each of `dirs` approved: these cases are about how layers
// resolve, so each approves the directories its layers live in.
const approving = (...dirs: string[]): RepoAnswers => ({
  kind: "ok",
  value: Object.fromEntries(dirs.map((d) => [realpathSync(d), "approved"])),
});

// Root bypasses directory permissions, so the unsearchable-directory fixtures
// cannot exist for it.
const asRoot = process.getuid?.() === 0;

function mkdir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cc-candybar-resolution-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// Isolate every test from the user's real XDG home + env var: the locations a
// test resolves under are parsed from an environment it states, never from the
// worker's own. These cases are about the main layout, so the environment is
// the worker's as a main home reads it.
function isolated(xdgHome: string, extra: NodeJS.ProcessEnv = {}): Locations {
  const { XDG_CONFIG_HOME: _x, CC_CANDYBAR_CONFIG: _c, ...rest } = mainEnv();
  const host = hostOf({ ...rest, XDG_CONFIG_HOME: xdgHome, ...extra });
  return locations(host, homeOf(host));
}

const VALID_CFG = JSON.stringify({
  globals: {},
  variables: { x: { kind: "literal", value: "ok" } },
  segments: {
    s: { template: " {{ .x }} ", bg: "surface", fg: "foreground" },
  },
  root: "s",
});

describe("dslConfigCandidatePaths", () => {
  test("emits .json5 and .json for every standard location, .json5 first", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      const project = join(dir, "proj");
      const cwd = join(dir, "cwd");
      mkdirSync(project);
      mkdirSync(cwd);
      const candidates = dslConfigCandidatePaths(L, project, cwd);
      // 3 locations × 2 extensions = 6 paths.
      expect(candidates.length).toBe(6);
      // Each location appears as a (.json5, .json) pair in order.
      expect(candidates[0]).toBe(join(project, ".cc-candybar.json5"));
      expect(candidates[1]).toBe(join(project, ".cc-candybar.json"));
      expect(candidates[2]).toBe(join(cwd, ".cc-candybar.json5"));
      expect(candidates[3]).toBe(join(cwd, ".cc-candybar.json"));
      expect(candidates[4]).toBe(join(dir, "cc-candybar", "config.json5"));
      expect(candidates[5]).toBe(join(dir, "cc-candybar", "config.json"));
    } finally {
      cleanup();
    }
  });

  // projectDir === cwd is the common shape of a hook payload; the project
  // and cwd rungs then spell the same two paths, and a consumer that probed
  // or reported them twice would name one location twice.
  test("the same directory as project and cwd yields each path once", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      const candidates = dslConfigCandidatePaths(L, dir, dir);
      expect(candidates).toEqual([
        join(dir, ".cc-candybar.json5"),
        join(dir, ".cc-candybar.json"),
        join(dir, "cc-candybar", "config.json5"),
        join(dir, "cc-candybar", "config.json"),
      ]);
    } finally {
      cleanup();
    }
  });

  test("an explicit configFile collapses precedence to one entry", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      const candidates = dslConfigCandidatePaths(L, 
        "/proj",
        "/cwd",
        "/explicit/path/to/config.json",
      );
      expect(candidates).toEqual(["/explicit/path/to/config.json"]);
    } finally {
      cleanup();
    }
  });

  // brandon-config-5g8: the daemon is detached, so ITS environment describes
  // whichever shell spawned it, not the session being rendered. The client
  // reports its CC_CANDYBAR_CONFIG as a hint (src/config-hint.ts) and the
  // daemon composes it into `configFile` at the request boundary — the
  // resolver never reads the variable itself.
  test("the process's own CC_CANDYBAR_CONFIG is not consulted", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
            expect(dslConfigCandidatePaths(L, "/proj", "/cwd")).toEqual(
        dslConfigCandidatePaths(L, "/proj", "/cwd", undefined),
      );
      expect(dslConfigCandidatePaths(L, "/proj", "/cwd")).not.toContain(
        "/explicit/path/to/config.json",
      );
    } finally {
      cleanup();
    }
  });
});

describe("resolveDslConfig", () => {
  test(".json at XDG resolves when no .json5 exists anywhere", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      const xdgCfgDir = join(dir, "cc-candybar");
      mkdirSync(xdgCfgDir);
      const jsonPath = join(xdgCfgDir, "config.json");
      writeFileSync(jsonPath, VALID_CFG);
      // No project, no cwd files. The .json at XDG is the only existing
      // candidate; the resolver must find it despite the legacy extension.
      const resolved = resolveDslConfig(L, approving(), undefined, dir);
      expect(resolved).toEqual({
        kind: "chain",
        layers: [{ path: jsonPath, scope: "plugins" }],
        home: jsonPath,
        unchecked: [],
        repos: NO_REPOS,
      });
    } finally {
      cleanup();
    }
  });

  test(".json5 wins over .json at the same location", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      const xdgCfgDir = join(dir, "cc-candybar");
      mkdirSync(xdgCfgDir);
      const json5Path = join(xdgCfgDir, "config.json5");
      const jsonPath = join(xdgCfgDir, "config.json");
      writeFileSync(json5Path, VALID_CFG);
      writeFileSync(jsonPath, VALID_CFG);
      const resolved = resolveDslConfig(L, approving(), undefined, dir);
      // Documented format outranks the legacy compatibility tail.
      expect(resolved).toEqual({
        kind: "chain",
        layers: [{ path: json5Path, scope: "plugins" }],
        home: json5Path,
        unchecked: [],
        repos: NO_REPOS,
      });
    } finally {
      cleanup();
    }
  });

  test("each location is a layer: project-local .json over XDG .json5", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      const proj = join(dir, "proj");
      mkdirSync(proj);
      const xdgCfgDir = join(dir, "cc-candybar");
      mkdirSync(xdgCfgDir);

      const projJson = join(proj, ".cc-candybar.json");
      const xdgJson5 = join(xdgCfgDir, "config.json5");
      writeFileSync(projJson, VALID_CFG);
      writeFileSync(xdgJson5, VALID_CFG);

      // Location orders the layers; the user's file stays the home.
      const resolved = resolveDslConfig(L, approving(proj), proj, dir);
      // An approved project's plugin folder is listed, whatever it holds.
      const repo = proj;
      expect(resolved).toEqual({
        kind: "chain",
        layers: [
          { path: xdgJson5, scope: "plugins" },
          { path: projJson, scope: "repo" },
        ],
        home: xdgJson5,
        unchecked: [],
        repos: {
          ...NO_REPOS,
          plugins: repo,
          approved: [realpathSync(proj)],
        },
      });
      expect(durableConfig(L, approving(proj), proj, dir)).toEqual({
        path: xdgJson5,
        above: [{ path: projJson, scope: "repo" }],
        repo,
        cwd: dir,
        locs: L,
      });
    } finally {
      cleanup();
    }
  });

  test("is an empty chain when no candidate exists — with nothing to say", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      // No files written anywhere — XDG dir doesn't even exist.
      const resolved = resolveDslConfig(L, approving(), undefined, dir);
      const home = join(dir, "cc-candybar", "config.json5");
      expect(resolved).toEqual({
        kind: "chain",
        layers: [],
        home,
        unchecked: [],
        repos: NO_REPOS,
      });
      expect(configResolutionNotice(resolved)).toBeNull();
      // A first durable write lands at the XDG tail, documented spelling.
      expect(durableConfig(L, approving(), undefined, dir)).toEqual({
        path: home,
        above: [],
        repo: null,
        cwd: dir,
        locs: L,
      });
    } finally {
      cleanup();
    }
  });

  test("an explicit file that exists is the whole chain, whatever else exists", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      const named = join(dir, "named.json5");
      const local = join(dir, ".cc-candybar.json5");
      writeFileSync(named, VALID_CFG);
      writeFileSync(local, VALID_CFG);
      expect(resolveDslConfig(L, approving(), dir, dir, named)).toEqual({
        kind: "chain",
        layers: [{ path: named, scope: "plugins" }],
        home: named,
        unchecked: [],
        repos: NO_REPOS,
      });
      expect(durableConfig(L, approving(), dir, dir, named)).toEqual({
        path: named,
        above: [],
        repo: null,
        cwd: dir,
        locs: L,
      });
    } finally {
      cleanup();
    }
  });

  // brandon-config-5g8: an explicit path to an absent file used to resolve
  // to the same null as "no config anywhere", so the bar rendered the
  // bundled default byte-identically to no override at all. `missing` is
  // its own arm, carries the path, and has a notice — while the chain is
  // NOT consulted (the user named a file; a project-local one is not it).
  test("an explicit file that is absent is `missing`, not `default`", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      const named = join(dir, "absent.json5");
      writeFileSync(join(dir, ".cc-candybar.json5"), VALID_CFG);
      const resolved = resolveDslConfig(L, approving(), dir, dir, named);
      expect(resolved).toEqual({
        kind: "missing",
        path: named,
        home: named,
        repos: NO_REPOS,
      });
      expect(configResolutionNotice(resolved)).toBe(
        `Config file not found: ${named} — rendering the bundled default until it appears`,
      );
      // A durable write creates the file the bar is waiting for.
      expect(durableConfig(L, approving(), dir, dir, named)).toEqual({
        path: named,
        above: [],
        repo: null,
        cwd: dir,
        locs: L,
      });
    } finally {
      cleanup();
    }
  });

  // Only ENOENT is absence. An explicit file behind an unsearchable
  // directory stats EACCES — the search cannot tell whether it is there, so
  // the verdict is `unreadable` carrying that errno, never a "not found"
  // notice about a path that may be right. Root bypasses directory
  // permissions, so the fixture cannot exist for it.
  (asRoot ? test.skip : test)(
    "an explicit file behind an unsearchable directory is `unreadable`, not `missing`",
    () => {
      const { dir, cleanup } = mkdir();
      const L = isolated(dir);
      const locked = join(dir, "locked");
      mkdirSync(locked);
      const named = join(locked, "named.json5");
      writeFileSync(named, VALID_CFG);
      chmodSync(locked, 0o000);
      try {
        const resolved = resolveDslConfig(L, approving(), dir, dir, named);
        expect(resolved).toEqual({
          kind: "unreadable",
          path: named,
          home: named,
          error: expect.stringContaining("EACCES"),
          repos: NO_REPOS,
        });
        expect(configResolutionNotice(resolved)).toMatch(
          /^Config file could not be read: /,
        );
        expect(configResolutionNotice(resolved)).toContain(named);
      } finally {
        chmodSync(locked, 0o755);
        cleanup();
      }
    },
  );

  // The automatic chain never halts on a guess: a location stat cannot see
  // past is carried as `unchecked` and the search continues, so a verified
  // lower candidate still wins — and the notice names every skipped
  // location, one per line, so the user knows the project-local file (if
  // any) was not the one loaded.
  (asRoot ? test.skip : test)(
    "an unsearchable chain location is skipped and named, not fatal",
    () => {
      const { dir, cleanup } = mkdir();
      const L = isolated(dir);
      const locked = join(dir, "locked");
      const cwd = join(dir, "cwd");
      mkdirSync(locked);
      mkdirSync(cwd);
      writeFileSync(join(locked, ".cc-candybar.json5"), VALID_CFG);
      const cwdFile = join(cwd, ".cc-candybar.json5");
      writeFileSync(cwdFile, VALID_CFG);
      chmodSync(locked, 0o000);
      try {
        const resolved = resolveDslConfig(L, approving(cwd), locked, cwd);
        expect(resolved).toEqual({
          kind: "chain",
          layers: [{ path: cwdFile, scope: "repo" }],
          home: join(dir, "cc-candybar", "config.json5"),
          unchecked: [
            {
              path: join(locked, ".cc-candybar.json5"),
              error: expect.stringContaining("EACCES"),
            },
            {
              path: join(locked, ".cc-candybar.json"),
              error: expect.stringContaining("EACCES"),
            },
          ],
          repos: { ...NO_REPOS, approved: [realpathSync(cwd)] },
        });
        const notice = configResolutionNotice(resolved);
        expect(notice).toContain("Config location could not be checked");
        expect(notice).toContain(join(locked, ".cc-candybar.json5"));
        expect(notice).toContain(join(locked, ".cc-candybar.json"));
        expect(notice?.split("\n")).toHaveLength(2);
        expect(durableConfig(L, approving(cwd), locked, cwd).above).toEqual([
          { path: cwdFile, scope: "repo" },
        ]);
        // The same directory as both project and cwd is still ONE location:
        // two unchecked entries (one per extension), two notice lines.
        const sameDir = resolveDslConfig(L, approving(), locked, locked);
        expect(sameDir).toHaveProperty("layers", []);
        expect(sameDir).toHaveProperty("unchecked.length", 2);
        expect(configResolutionNotice(sameDir)?.split("\n")).toHaveLength(2);
      } finally {
        chmodSync(locked, 0o755);
        cleanup();
      }
    },
  );
});

describe("detectConfigCollisions", () => {
  test("returns null when no duplicates exist", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      const xdgCfgDir = join(dir, "cc-candybar");
      mkdirSync(xdgCfgDir);
      writeFileSync(join(xdgCfgDir, "config.json5"), VALID_CFG);
      // Only the .json5 exists.
      expect(detectConfigCollisions(L, undefined, dir)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("returns a warning when both .json5 and .json exist at same location", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      const xdgCfgDir = join(dir, "cc-candybar");
      mkdirSync(xdgCfgDir);
      const json5 = join(xdgCfgDir, "config.json5");
      const json = join(xdgCfgDir, "config.json");
      writeFileSync(json5, VALID_CFG);
      writeFileSync(json, VALID_CFG);

      const warning = detectConfigCollisions(L, undefined, dir);
      expect(warning).not.toBeNull();
      // Message names both files so the user can locate the duplicate.
      expect(warning).toContain(json5);
      expect(warning).toContain(json);
      // Stable wording so downstream UI can pattern-match the diagnostic.
      expect(warning).toMatch(/shadows/);
    } finally {
      cleanup();
    }
  });

  test("reports collisions at multiple locations independently", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      const proj = join(dir, "proj");
      mkdirSync(proj);
      const xdgCfgDir = join(dir, "cc-candybar");
      mkdirSync(xdgCfgDir);

      // Two collisions, one per location.
      writeFileSync(join(proj, ".cc-candybar.json5"), VALID_CFG);
      writeFileSync(join(proj, ".cc-candybar.json"), VALID_CFG);
      writeFileSync(join(xdgCfgDir, "config.json5"), VALID_CFG);
      writeFileSync(join(xdgCfgDir, "config.json"), VALID_CFG);

      const warning = detectConfigCollisions(L, proj, dir);
      expect(warning).not.toBeNull();
      // Both location's .json5 + .json should be mentioned.
      expect(warning).toContain(join(proj, ".cc-candybar.json5"));
      expect(warning).toContain(join(proj, ".cc-candybar.json"));
      expect(warning).toContain(join(xdgCfgDir, "config.json5"));
      expect(warning).toContain(join(xdgCfgDir, "config.json"));
    } finally {
      cleanup();
    }
  });

  // Presence the detector cannot verify is not a collision: an unsearchable
  // location is `Unchecked` for both spellings, and the resolver's notice is
  // what names the errno — a fabricated "shadows" warning beside it would
  // assert a fact nothing checked.
  (asRoot ? test.skip : test)(
    "reports nothing for a location it cannot search",
    () => {
      const { dir, cleanup } = mkdir();
      const L = isolated(dir);
      const locked = join(dir, "locked");
      mkdirSync(locked);
      writeFileSync(join(locked, ".cc-candybar.json5"), VALID_CFG);
      writeFileSync(join(locked, ".cc-candybar.json"), VALID_CFG);
      chmodSync(locked, 0o000);
      try {
        expect(detectConfigCollisions(L, locked, locked)).toBeNull();
      } finally {
        chmodSync(locked, 0o755);
        cleanup();
      }
    },
  );

  test("ignores cross-location pairs (proj/.json5 + cwd/.json is not a collision)", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      const proj = join(dir, "proj");
      const cwd = join(dir, "cwd");
      mkdirSync(proj);
      mkdirSync(cwd);
      // .json5 at project, .json at cwd — different locations, no collision.
      writeFileSync(join(proj, ".cc-candybar.json5"), VALID_CFG);
      writeFileSync(join(cwd, ".cc-candybar.json"), VALID_CFG);
      expect(detectConfigCollisions(L, proj, cwd)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("the layer chain", () => {
  // The locations the current test resolves under.
  let L: Locations;
  // A project config in `dir`, a user config under the isolated XDG home.
  function withBoth(run: (project: string, user: string) => void): void {
    const { dir, cleanup } = mkdir();
    L = isolated(dir);
    try {
      const xdgCfgDir = join(dir, "cc-candybar");
      mkdirSync(xdgCfgDir);
      const project = join(dir, ".cc-candybar.json5");
      const user = join(xdgCfgDir, "config.json5");
      writeFileSync(project, VALID_CFG);
      writeFileSync(user, VALID_CFG);
      run(dir, user);
    } finally {
      cleanup();
    }
  }
  const layersOf = (projectDir: string, cwd: string, configFile?: string) => {
    const r = resolveDslConfig(L, 
      approving(projectDir),
      projectDir,
      cwd,
      configFile,
    );
    return r.kind === "chain" ? r.layers.map((l) => l.path) : null;
  };

  test("the user's file is the bottom layer, the project's on top", () => {
    withBoth((project, user) => {
      expect(layersOf(project, project)).toEqual([
        user,
        join(project, ".cc-candybar.json5"),
      ]);
    });
  });

  test("a location's .json sibling is the collision, not a second layer", () => {
    withBoth((project, user) => {
      writeFileSync(join(project, ".cc-candybar.json"), VALID_CFG);
      expect(layersOf(project, project)).toEqual([
        user,
        join(project, ".cc-candybar.json5"),
      ]);
      expect(detectConfigCollisions(L, project, project)).not.toBeNull();
    });
  });

  test("one directory spelled two ways is one layer, never a file over itself", () => {
    withBoth((project, user) => {
      const alias = join(project, "alias");
      symlinkSync(project, alias);
      expect(layersOf(alias, project)).toHaveLength(2);
      expect(layersOf(alias, project)?.[0]).toBe(user);
    });
  });

  test("an explicit config file bypasses the search: it is the only layer", () => {
    withBoth((project, user) => {
      expect(layersOf(project, project, user)).toEqual([user]);
    });
  });
});
