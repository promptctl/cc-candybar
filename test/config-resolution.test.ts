// [LAW:single-enforcer] Tests for dsl-loader's path resolution and
// collision detection — the single enumerator (dslConfigCandidatePaths)
// feeds the resolver, the watcher, and the collision detector. Behavior
// under test:
//   - .json5 and .json are both accepted at every location
//   - .json5 wins over .json at the same location (documented > legacy)
//   - every location's file is a layer: XDG < cwd < project
//   - collisionsOf surfaces same-location duplicates
//   - chainPlaces names the file each writable role of the chain lands in

import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { locations } from "../src/daemon/paths";
import {
  chainPlaces,
  configLocations,
  type Locations,
} from "../src/config/loader/chain-places";
import { hostOf } from "./helpers/host";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configResolutionNotice,
  dslConfigCandidatePaths,
} from "../src/config/dsl-loader";
import {
  configCollisionNotice,
  observeConfigLocations,
  searchConfig,
} from "../src/daemon/config-discovery/config-search";
import { resolutionOf } from "./helpers/config-search";
import { diskFiles } from "../src/daemon/config-discovery/discovery-files";
import type { RepoAnswers } from "../src/config/loader/repo-gate";

// The answers with each of `dirs` approved: these cases are about how layers
// resolve, so each approves the directories its layers live in.
const approving = (...dirs: string[]): RepoAnswers => ({
  kind: "ok",
  value: Object.fromEntries(dirs.map((d) => [realpathSync(d), "approved"])),
});

// What a session reaching no repository's config contributes, or whose
// repositories are approved and ship no plugins.
const collisionsOf = (locs: Locations, projectDir?: string) =>
  configCollisionNotice(
    searchConfig(locs, approving(), { projectDir }).locations,
  );

const NOTHING_GATED = {
  plugins: null,
  approved: [],
  awaiting: [],
  declined: [],
  unproven: [],
  unread: null,
};

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
// worker's own.
function isolated(xdgHome: string, extra: NodeJS.ProcessEnv = {}): Locations {
  const { XDG_CONFIG_HOME: _x, CC_CANDYBAR_CONFIG: _c, ...rest } = process.env;
  return locations(hostOf({ ...rest, XDG_CONFIG_HOME: xdgHome, ...extra }));
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
      mkdirSync(project);
      // The local file, the project's, the user's: highest precedence first,
      // each a (.json5, .json) pair.
      expect(dslConfigCandidatePaths(L, { projectDir: project })).toEqual([
        join(project, ".cc-candybar.local.json5"),
        join(project, ".cc-candybar.local.json"),
        join(project, ".cc-candybar.json5"),
        join(project, ".cc-candybar.json"),
        join(dir, "cc-candybar", "config.json5"),
        join(dir, "cc-candybar", "config.json"),
      ]);
    } finally {
      cleanup();
    }
  });

  test("with no project the user's file is the only location", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      expect(dslConfigCandidatePaths(L, {})).toEqual([
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
      const candidates = dslConfigCandidatePaths(L, {
        projectDir: "/proj",
        configFile: "/explicit/path/to/config.json",
      });
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
      expect(dslConfigCandidatePaths(L, { projectDir: "/proj" })).toEqual(
        dslConfigCandidatePaths(L, {
          projectDir: "/proj",
          configFile: undefined,
        }),
      );
      expect(dslConfigCandidatePaths(L, { projectDir: "/proj" })).not.toContain(
        "/explicit/path/to/config.json",
      );
    } finally {
      cleanup();
    }
  });
});

describe("the config search", () => {
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
      const resolved = resolutionOf(L, approving(), {});
      expect(resolved).toEqual({
        kind: "chain",
        layers: [{ path: jsonPath, role: "user" }],
        home: jsonPath,
        unchecked: [],
        repos: NOTHING_GATED,
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
      const resolved = resolutionOf(L, approving(), {});
      // Documented format outranks the legacy compatibility tail.
      expect(resolved).toEqual({
        kind: "chain",
        layers: [{ path: json5Path, role: "user" }],
        home: json5Path,
        unchecked: [],
        repos: NOTHING_GATED,
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
      const resolved = resolutionOf(L, approving(proj), {
        projectDir: proj,
      });
      // An approved project's plugin folder is listed, whatever it holds.
      const repo = proj;
      expect(resolved).toEqual({
        kind: "chain",
        layers: [
          { path: xdgJson5, role: "user" },
          { path: projJson, role: "project" },
        ],
        home: xdgJson5,
        unchecked: [],
        repos: {
          ...NOTHING_GATED,
          plugins: repo,
          approved: [realpathSync(proj)],
        },
      });
      const query = { projectDir: proj, cwd: dir };
      // The user's file, the project's own over it, and the local file a
      // first write there creates, over both.
      expect(
        chainPlaces(resolutionOf(L, approving(proj), query), query),
      ).toEqual([
        { path: xdgJson5, role: "user" },
        { path: projJson, role: "project" },
        { path: join(proj, ".cc-candybar.local.json5"), role: "local" },
      ]);
      // Unapproved, the project's layers are not the session's to write.
      const unanswered = { kind: "ok", value: {} } as const;
      expect(chainPlaces(resolutionOf(L, unanswered, query), query)).toEqual([
        { path: xdgJson5, role: "user" },
      ]);
    } finally {
      cleanup();
    }
  });

  test("is an empty chain when no candidate exists — with nothing to say", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      // No files written anywhere — XDG dir doesn't even exist.
      const resolved = resolutionOf(L, approving(), {});
      const home = join(dir, "cc-candybar", "config.json5");
      expect(resolved).toEqual({
        kind: "chain",
        layers: [],
        home,
        unchecked: [],
        repos: NOTHING_GATED,
      });
      expect(configResolutionNotice(resolved)).toBeNull();
      // A first durable write lands at the XDG tail, documented spelling.
      expect(chainPlaces(resolved, {})).toEqual([{ path: home, role: "user" }]);
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
      expect(
        resolutionOf(L, approving(), {
          projectDir: dir,
          configFile: named,
        }),
      ).toEqual({
        kind: "chain",
        layers: [{ path: named, role: "user" }],
        home: named,
        unchecked: [],
        repos: NOTHING_GATED,
      });
      const query = { projectDir: dir, cwd: dir, configFile: named };
      // The named file is the chain's one layer: there is no other to write.
      expect(
        chainPlaces(resolutionOf(L, approving(dir), query), query),
      ).toEqual([{ path: named, role: "user" }]);
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
      const resolved = resolutionOf(L, approving(), {
        projectDir: dir,
        configFile: named,
      });
      expect(resolved).toEqual({
        kind: "missing",
        unchecked: [],
        path: named,
        home: named,
        repos: NOTHING_GATED,
      });
      expect(configResolutionNotice(resolved)).toBe(
        `Config file not found: ${named} — rendering the bundled default until it appears`,
      );
      // A durable write creates the file the bar is waiting for.
      const query = { projectDir: dir, cwd: dir, configFile: named };
      // The named file is the chain's one layer: there is no other to write.
      expect(
        chainPlaces(resolutionOf(L, approving(dir), query), query),
      ).toEqual([{ path: named, role: "user" }]);
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
        const resolved = resolutionOf(L, approving(), {
          projectDir: dir,
          configFile: named,
        });
        expect(resolved).toEqual({
          kind: "unreadable",
          unchecked: [],
          path: named,
          home: named,
          error: expect.stringContaining("EACCES"),
          repos: NOTHING_GATED,
        });
        // The load names the file it could not read; the search adds none.
        expect(configResolutionNotice(resolved)).toBeNull();
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
      mkdirSync(locked);
      writeFileSync(join(locked, ".cc-candybar.json5"), VALID_CFG);
      const xdgCfgDir = join(dir, "cc-candybar");
      mkdirSync(xdgCfgDir);
      const userFile = join(xdgCfgDir, "config.json5");
      writeFileSync(userFile, VALID_CFG);
      chmodSync(locked, 0o000);
      try {
        const resolved = resolutionOf(L, approving(), {
          projectDir: locked,
        });
        const skipped = [
          ".cc-candybar.local.json5",
          ".cc-candybar.local.json",
          ".cc-candybar.json5",
          ".cc-candybar.json",
        ].map((base) => join(locked, base));
        expect(resolved).toEqual({
          kind: "chain",
          layers: [{ path: userFile, role: "user" }],
          home: userFile,
          unchecked: skipped.map((path) => ({
            path,
            error: expect.stringContaining("EACCES"),
          })),
          repos: NOTHING_GATED,
        });
        const notice = configResolutionNotice(resolved);
        expect(notice).toContain("Config location could not be checked");
        for (const path of skipped) expect(notice).toContain(path);
        expect(notice?.split("\n")).toHaveLength(skipped.length);
      } finally {
        chmodSync(locked, 0o755);
        cleanup();
      }
    },
  );
});

test("a failed project stat is still reported when the explicit config is missing or unreadable", () => {
  const locs = isolated("/config-home");
  const projectDir = "/permission-denied";
  const configFile = "/asked.json5";
  for (const verdict of ["absent", "unchecked"] as const) {
    const files = {
      ...diskFiles,
      presence(file: string) {
        if (file === projectDir) return { path: file, error: "project EACCES" };
        return verdict === "absent"
          ? verdict
          : { path: file, error: "config ELOOP" };
      },
    };
    const { resolution } = searchConfig(
      locs,
      approving(),
      { projectDir, configFile },
      files,
    );
    expect(resolution.kind).toBe(
      verdict === "absent" ? "missing" : "unreadable",
    );
    expect(configResolutionNotice(resolution)).toContain(
      `Config location could not be checked: ${projectDir} — project EACCES`,
    );
  }
});

describe("config collisions", () => {
  test("another extension is a sibling of the same location", () => {
    const candidates = configLocations(isolated("/config-home"), {}, [
      "json5",
      "json",
      "jsonc",
    ]);
    const stated = observeConfigLocations(candidates, {
      presence: () => "present",
      realpath: (file) => file,
    });
    expect(stated).toHaveLength(1);
    expect(stated[0]).toMatchObject({
      kind: "found",
      role: "user",
      winner: { extension: "json5" },
      shadowed: [{ extension: "json" }, { extension: "jsonc" }],
    });
    expect(configCollisionNotice(stated)).toMatch(
      /config\.json5 shadows .*config\.json, .*config\.jsonc/,
    );
  });

  test("returns null when no duplicates exist", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      const xdgCfgDir = join(dir, "cc-candybar");
      mkdirSync(xdgCfgDir);
      writeFileSync(join(xdgCfgDir, "config.json5"), VALID_CFG);
      // Only the .json5 exists.
      expect(collisionsOf(L)).toBeNull();
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

      const warning = collisionsOf(L);
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

      const warning = collisionsOf(L, proj);
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
        expect(collisionsOf(L, locked)).toBeNull();
      } finally {
        chmodSync(locked, 0o755);
        cleanup();
      }
    },
  );

  test("ignores cross-location pairs (the project's .json5 + its local .json is not a collision)", () => {
    const { dir, cleanup } = mkdir();
    const L = isolated(dir);
    try {
      const proj = join(dir, "proj");
      mkdirSync(proj);
      // The project's file and its local one are two locations.
      writeFileSync(join(proj, ".cc-candybar.json5"), VALID_CFG);
      writeFileSync(join(proj, ".cc-candybar.local.json"), VALID_CFG);
      expect(collisionsOf(L, proj)).toBeNull();
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
  const layersOf = (
    projectDir: string,
    configFile?: string,
    answers = approving(projectDir),
  ) => {
    const r = resolutionOf(L, answers, { projectDir, configFile });
    return r.kind === "chain" ? r.layers.map((l) => l.path) : null;
  };

  test("the user's file is the bottom layer, the project's on top", () => {
    withBoth((project, user) => {
      expect(layersOf(project)).toEqual([
        user,
        join(project, ".cc-candybar.json5"),
      ]);
    });
  });

  test("a location's .json sibling is the collision, not a second layer", () => {
    withBoth((project, user) => {
      writeFileSync(join(project, ".cc-candybar.json"), VALID_CFG);
      expect(layersOf(project)).toEqual([
        user,
        join(project, ".cc-candybar.json5"),
      ]);
      expect(collisionsOf(L, project)).not.toBeNull();
    });
  });

  // A clone can commit a file by the local name, so it is the repository's
  // as much as the project's file is.
  test("the local file is the top layer, and loads only under the project's approval", () => {
    withBoth((project, user) => {
      const local = join(project, ".cc-candybar.local.json5");
      writeFileSync(local, VALID_CFG);
      expect(layersOf(project)).toEqual([
        user,
        join(project, ".cc-candybar.json5"),
        local,
      ]);
      expect(layersOf(project, undefined, approving())).toEqual([user]);
    });
  });

  test("an explicit config file bypasses the search: it is the only layer", () => {
    withBoth((project, user) => {
      expect(layersOf(project, user)).toEqual([user]);
    });
  });
});
