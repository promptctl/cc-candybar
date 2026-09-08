// [LAW:single-enforcer] One enumerator (dslConfigCandidatePaths) feeds the resolver, the watcher and the collision detector.

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

// Root bypasses directory permissions, so the unsearchable-directory fixtures cannot exist.
const asRoot = process.getuid?.() === 0;

function mkdir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cc-candybar-resolution-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

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
      expect(candidates.length).toBe(6);
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

  // projectDir === cwd is the common hook-payload shape; both rungs spell the same paths.
  test("the same directory as project and cwd yields each path once", () => {
    const { dir, cleanup } = mkdir();
    const restore = isolateEnv(dir);
    try {
      const candidates = dslConfigCandidatePaths(dir, dir);
      expect(candidates).toEqual([
        join(dir, ".cc-candybar.json5"),
        join(dir, ".cc-candybar.json"),
        join(dir, "cc-candybar", "config.json5"),
        join(dir, "cc-candybar", "config.json"),
      ]);
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

  // The daemon is detached, so ITS env describes whichever shell spawned it, not the session.
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
      const resolved = resolveDslConfig(undefined, dir);
      expect(resolved).toEqual({ kind: "default", unchecked: [] });
      expect(configResolutionNotice(resolved)).toBeNull();
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

  // `missing` is its own arm and the chain is NOT consulted — the user named a file.
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
      expect(durableConfigPath(dir, dir, named)).toBe(named);
    } finally {
      restore();
      cleanup();
    }
  });

  // Only ENOENT is absence: EACCES is `unreadable` carrying the errno, never "not found".
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

  // The chain never halts on a guess: an unseeable location is `unchecked` and the search goes on.
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
        // One directory as both project and cwd is still ONE location: two entries, two lines.
        const sameDir = resolveDslConfig(locked, locked);
        expect(sameDir.kind).toBe("default");
        expect(sameDir).toHaveProperty("unchecked.length", 2);
        expect(configResolutionNotice(sameDir)?.split("\n")).toHaveLength(2);
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

      writeFileSync(join(proj, ".cc-candybar.json5"), VALID_CFG);
      writeFileSync(join(proj, ".cc-candybar.json"), VALID_CFG);
      writeFileSync(join(xdgCfgDir, "config.json5"), VALID_CFG);
      writeFileSync(join(xdgCfgDir, "config.json"), VALID_CFG);

      const warning = detectConfigCollisions(proj, dir);
      expect(warning).not.toBeNull();
      expect(warning).toContain(join(proj, ".cc-candybar.json5"));
      expect(warning).toContain(join(proj, ".cc-candybar.json"));
      expect(warning).toContain(join(xdgCfgDir, "config.json5"));
      expect(warning).toContain(join(xdgCfgDir, "config.json"));
    } finally {
      restore();
      cleanup();
    }
  });

  // Presence the detector cannot verify is not a collision — a "shadows" warning would assert an unchecked fact.
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
      writeFileSync(join(proj, ".cc-candybar.json5"), VALID_CFG);
      writeFileSync(join(cwd, ".cc-candybar.json"), VALID_CFG);
      expect(detectConfigCollisions(proj, cwd)).toBeNull();
    } finally {
      restore();
      cleanup();
    }
  });
});
