// [LAW:single-enforcer] Tests for dsl-loader's path resolution and
// collision detection — the single enumerator (dslConfigCandidatePaths)
// feeds the resolver, the watcher, and the collision detector. Behavior
// under test:
//   - .json5 and .json are both accepted at every location
//   - .json5 wins over .json at the same location (documented > legacy)
//   - location precedence (project > cwd > XDG) overrides extension
//   - detectConfigCollisions surfaces same-location duplicates

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveDslConfigPath,
  dslConfigCandidatePaths,
  detectConfigCollisions,
} from "../src/config/dsl-loader";

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

  test("CC_CANDYBAR_CONFIG collapses precedence to one entry", () => {
    const { dir, cleanup } = mkdir();
    const restore = isolateEnv(dir);
    try {
      process.env.CC_CANDYBAR_CONFIG = "/explicit/path/to/config.json";
      const candidates = dslConfigCandidatePaths("/proj", "/cwd");
      expect(candidates).toEqual(["/explicit/path/to/config.json"]);
    } finally {
      restore();
      cleanup();
    }
  });
});

describe("resolveDslConfigPath", () => {
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
      const resolved = resolveDslConfigPath(undefined, dir);
      expect(resolved).toBe(jsonPath);
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
      const resolved = resolveDslConfigPath(undefined, dir);
      // Documented format outranks the legacy compatibility tail.
      expect(resolved).toBe(json5Path);
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
      const resolved = resolveDslConfigPath(proj, dir);
      expect(resolved).toBe(projJson);
    } finally {
      restore();
      cleanup();
    }
  });

  test("returns null when no candidate exists", () => {
    const { dir, cleanup } = mkdir();
    const restore = isolateEnv(dir);
    try {
      // No files written anywhere — XDG dir doesn't even exist.
      expect(resolveDslConfigPath(undefined, dir)).toBeNull();
    } finally {
      restore();
      cleanup();
    }
  });
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
