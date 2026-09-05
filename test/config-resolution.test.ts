// [LAW:single-enforcer] Tests for dsl-loader's path resolution and
// collision detection — the single enumerator (dslConfigCandidatePaths)
// feeds the resolver, the watcher, and the collision detector. Behavior
// under test:
//   - .json5 and .json are both accepted at every location
//   - .json5 wins over .json at the same location (documented > legacy)
//   - location precedence (project > cwd > XDG) overrides extension
//   - detectConfigCollisions surfaces same-location duplicates

import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveDslConfig,
  configResolutionNotice,
  durableConfigPath,
  dslConfigCandidatePaths,
  detectConfigCollisions,
} from "../src/config/dsl-loader";

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

// Isolate every test from the user's real XDG home + env var.
function isolateEnv(xdgHome: string): () => void {
  const savedXdg = process.env.XDG_CONFIG_HOME;
  const savedCfg = process.env.CC_CANDYBAR_CONFIG;
  process.env.XDG_CONFIG_HOME = xdgHome;
  delete process.env.CC_CANDYBAR_CONFIG;
  return () => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedCfg === undefined) delete process.env.CC_CANDYBAR_CONFIG;
    else process.env.CC_CANDYBAR_CONFIG = savedCfg;
  };
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
    const restore = isolateEnv(dir);
    try {
      const project = join(dir, "proj");
      const cwd = join(dir, "cwd");
      mkdirSync(project);
      mkdirSync(cwd);
      const candidates = dslConfigCandidatePaths(project, cwd);
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
      restore();
      cleanup();
    }
  });

  test("an explicit configFile collapses precedence to one entry", () => {
    const { dir, cleanup } = mkdir();
    const restore = isolateEnv(dir);
    try {
      const candidates = dslConfigCandidatePaths(
        "/proj",
        "/cwd",
        "/explicit/path/to/config.json",
      );
      expect(candidates).toEqual(["/explicit/path/to/config.json"]);
    } finally {
      restore();
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
    const restore = isolateEnv(dir);
    try {
      process.env.CC_CANDYBAR_CONFIG = "/explicit/path/to/config.json";
      expect(dslConfigCandidatePaths("/proj", "/cwd")).toEqual(
        dslConfigCandidatePaths("/proj", "/cwd", undefined),
      );
      expect(dslConfigCandidatePaths("/proj", "/cwd")).not.toContain(
        "/explicit/path/to/config.json",
      );
    } finally {
      restore();
      cleanup();
    }
  });
});

describe("resolveDslConfig", () => {
  test(".json at XDG resolves when no .json5 exists anywhere", () => {
    const { dir, cleanup } = mkdir();
    const restore = isolateEnv(dir);
    try {
      const xdgCfgDir = join(dir, "cc-candybar");
      mkdirSync(xdgCfgDir);
      const jsonPath = join(xdgCfgDir, "config.json");
      writeFileSync(jsonPath, VALID_CFG);
      // No project, no cwd files. The .json at XDG is the only existing
      // candidate; the resolver must find it despite the legacy extension.
      const resolved = resolveDslConfig(undefined, dir);
      expect(resolved).toEqual({ kind: "file", path: jsonPath, unchecked: [] });
    } finally {
      restore();
      cleanup();
    }
  });

  test(".json5 wins over .json at the same location", () => {
    const { dir, cleanup } = mkdir();
    const restore = isolateEnv(dir);
    try {
      const xdgCfgDir = join(dir, "cc-candybar");
      mkdirSync(xdgCfgDir);
      const json5Path = join(xdgCfgDir, "config.json5");
      const jsonPath = join(xdgCfgDir, "config.json");
      writeFileSync(json5Path, VALID_CFG);
      writeFileSync(jsonPath, VALID_CFG);
      const resolved = resolveDslConfig(undefined, dir);
      // Documented format outranks the legacy compatibility tail.
      expect(resolved).toEqual({
        kind: "file",
        path: json5Path,
        unchecked: [],
      });
    } finally {
      restore();
      cleanup();
    }
  });

  test("location precedence: project-local .json outranks XDG .json5", () => {
    const { dir, cleanup } = mkdir();
    const restore = isolateEnv(dir);
    try {
      const proj = join(dir, "proj");
      mkdirSync(proj);
      const xdgCfgDir = join(dir, "cc-candybar");
      mkdirSync(xdgCfgDir);

      const projJson = join(proj, ".cc-candybar.json");
      const xdgJson5 = join(xdgCfgDir, "config.json5");
      writeFileSync(projJson, VALID_CFG);
      writeFileSync(xdgJson5, VALID_CFG);

      // Location dominates extension: project-local .json beats global .json5.
      const resolved = resolveDslConfig(proj, dir);
      expect(resolved).toEqual({ kind: "file", path: projJson, unchecked: [] });
    } finally {
      restore();
      cleanup();
    }
  });

  test("is `default` when no candidate exists — with nothing to say", () => {
    const { dir, cleanup } = mkdir();
    const restore = isolateEnv(dir);
    try {
      // No files written anywhere — XDG dir doesn't even exist.
      const resolved = resolveDslConfig(undefined, dir);
      expect(resolved).toEqual({ kind: "default", unchecked: [] });
      expect(configResolutionNotice(resolved)).toBeNull();
      // A first durable write lands at the XDG tail, documented spelling.
      expect(durableConfigPath(undefined, dir)).toBe(
        join(dir, "cc-candybar", "config.json5"),
      );
    } finally {
      restore();
      cleanup();
    }
  });

  test("an explicit file that exists is `file`, whatever the chain holds", () => {
    const { dir, cleanup } = mkdir();
    const restore = isolateEnv(dir);
    try {
      const named = join(dir, "named.json5");
      const local = join(dir, ".cc-candybar.json5");
      writeFileSync(named, VALID_CFG);
      writeFileSync(local, VALID_CFG);
      expect(resolveDslConfig(dir, dir, named)).toEqual({
        kind: "file",
        path: named,
        unchecked: [],
      });
      expect(durableConfigPath(dir, dir, named)).toBe(named);
    } finally {
      restore();
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
    const restore = isolateEnv(dir);
    try {
      const named = join(dir, "absent.json5");
      writeFileSync(join(dir, ".cc-candybar.json5"), VALID_CFG);
      const resolved = resolveDslConfig(dir, dir, named);
      expect(resolved).toEqual({ kind: "missing", path: named });
      expect(configResolutionNotice(resolved)).toBe(
        `Config file not found: ${named} — rendering the bundled default until it appears`,
      );
      // A durable write creates the file the bar is waiting for.
      expect(durableConfigPath(dir, dir, named)).toBe(named);
    } finally {
      restore();
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
      const restore = isolateEnv(dir);
      const locked = join(dir, "locked");
      mkdirSync(locked);
      const named = join(locked, "named.json5");
      writeFileSync(named, VALID_CFG);
      chmodSync(locked, 0o000);
      try {
        const resolved = resolveDslConfig(dir, dir, named);
        expect(resolved).toEqual({
          kind: "unreadable",
          path: named,
          error: expect.stringContaining("EACCES"),
        });
        expect(configResolutionNotice(resolved)).toMatch(
          /^Config file could not be read: /,
        );
        expect(configResolutionNotice(resolved)).toContain(named);
      } finally {
        chmodSync(locked, 0o755);
        restore();
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
      const restore = isolateEnv(dir);
      const locked = join(dir, "locked");
      const cwd = join(dir, "cwd");
      mkdirSync(locked);
      mkdirSync(cwd);
      writeFileSync(join(locked, ".cc-candybar.json5"), VALID_CFG);
      const cwdFile = join(cwd, ".cc-candybar.json5");
      writeFileSync(cwdFile, VALID_CFG);
      chmodSync(locked, 0o000);
      try {
        const resolved = resolveDslConfig(locked, cwd);
        expect(resolved).toEqual({
          kind: "file",
          path: cwdFile,
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
        });
        const notice = configResolutionNotice(resolved);
        expect(notice).toContain("Config location could not be checked");
        expect(notice).toContain(join(locked, ".cc-candybar.json5"));
        expect(notice).toContain(join(locked, ".cc-candybar.json"));
        expect(notice?.split("\n")).toHaveLength(2);
        expect(durableConfigPath(locked, cwd)).toBe(cwdFile);
      } finally {
        chmodSync(locked, 0o755);
        restore();
        cleanup();
      }
    },
  );
});

describe("detectConfigCollisions", () => {
  test("returns null when no duplicates exist", () => {
    const { dir, cleanup } = mkdir();
    const restore = isolateEnv(dir);
    try {
      const xdgCfgDir = join(dir, "cc-candybar");
      mkdirSync(xdgCfgDir);
      writeFileSync(join(xdgCfgDir, "config.json5"), VALID_CFG);
      // Only the .json5 exists.
      expect(detectConfigCollisions(undefined, dir)).toBeNull();
    } finally {
      restore();
      cleanup();
    }
  });

  test("returns a warning when both .json5 and .json exist at same location", () => {
    const { dir, cleanup } = mkdir();
    const restore = isolateEnv(dir);
    try {
      const xdgCfgDir = join(dir, "cc-candybar");
      mkdirSync(xdgCfgDir);
      const json5 = join(xdgCfgDir, "config.json5");
      const json = join(xdgCfgDir, "config.json");
      writeFileSync(json5, VALID_CFG);
      writeFileSync(json, VALID_CFG);

      const warning = detectConfigCollisions(undefined, dir);
      expect(warning).not.toBeNull();
      // Message names both files so the user can locate the duplicate.
      expect(warning).toContain(json5);
      expect(warning).toContain(json);
      // Stable wording so downstream UI can pattern-match the diagnostic.
      expect(warning).toMatch(/shadows/);
    } finally {
      restore();
      cleanup();
    }
  });

  test("reports collisions at multiple locations independently", () => {
    const { dir, cleanup } = mkdir();
    const restore = isolateEnv(dir);
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

      const warning = detectConfigCollisions(proj, dir);
      expect(warning).not.toBeNull();
      // Both location's .json5 + .json should be mentioned.
      expect(warning).toContain(join(proj, ".cc-candybar.json5"));
      expect(warning).toContain(join(proj, ".cc-candybar.json"));
      expect(warning).toContain(join(xdgCfgDir, "config.json5"));
      expect(warning).toContain(join(xdgCfgDir, "config.json"));
    } finally {
      restore();
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
      const restore = isolateEnv(dir);
      const locked = join(dir, "locked");
      mkdirSync(locked);
      writeFileSync(join(locked, ".cc-candybar.json5"), VALID_CFG);
      writeFileSync(join(locked, ".cc-candybar.json"), VALID_CFG);
      chmodSync(locked, 0o000);
      try {
        expect(detectConfigCollisions(locked, locked)).toBeNull();
      } finally {
        chmodSync(locked, 0o755);
        restore();
        cleanup();
      }
    },
  );

  test("ignores cross-location pairs (proj/.json5 + cwd/.json is not a collision)", () => {
    const { dir, cleanup } = mkdir();
    const restore = isolateEnv(dir);
    try {
      const proj = join(dir, "proj");
      const cwd = join(dir, "cwd");
      mkdirSync(proj);
      mkdirSync(cwd);
      // .json5 at project, .json at cwd — different locations, no collision.
      writeFileSync(join(proj, ".cc-candybar.json5"), VALID_CFG);
      writeFileSync(join(cwd, ".cc-candybar.json"), VALID_CFG);
      expect(detectConfigCollisions(proj, cwd)).toBeNull();
    } finally {
      restore();
      cleanup();
    }
  });
});
