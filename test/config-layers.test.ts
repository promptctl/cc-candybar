// brandon-plugins-ktag.8th: a project config layers over the user's config
// instead of replacing it — bundled < user < project, through the one merge —
// and a durable click writes the user's file, refusing a change a project
// layer would hide.

import { SAMPLE_REGION } from "../scripts/lib/draw-fixtures/sample-region.js";
import fs from "node:fs";
import { hostOf } from "../scripts/lib/host";
import { worldOf } from "./helpers/host";
import type { Host, World } from "../src/host";
import { locations } from "../src/daemon/paths";
import os from "node:os";
import path from "node:path";
import { renderConfig, type ConfigDraw } from "./helpers/config-fixture";
import { prepareConfig } from "../scripts/lib/draw-fixtures/prepared-config";
import { homeLayer } from "../src/config/dsl-loader";
import { loadDiscovered, originOf } from "./helpers/config-host";
import { SessionState } from "../src/renderer/session-state";
import { systemTimekeeper } from "../scripts/lib/system-clock";
import { bareGates } from "./helpers/gates";
import { loadChain } from "./helpers/discovered-load";
import { contentOfText } from "../src/config/config-snapshot";
import type { LayerRole } from "../src/config/layer-role";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import {
  deleteValues,
  writePreset,
  writeValues,
} from "../src/renderer/config-file-store";
import { resolutionOf } from "./helpers/config-search";
import { instantOf } from "../src/utils/instant";
import { repoConfigs } from "../src/daemon/config-discovery/repo-configs";
import { stateDir } from "../src/daemon/paths";
import { answerRepo } from "./helpers/repo-approval";
import { applyLayoutOp } from "../src/renderer/config-file-store";
import { walkNodes } from "../src/config/dsl-types";
import { fragmentNode } from "../src/config/root";
import { textOf, type Frame } from "../src/render/frame";
import { EDITS_IN_PLACE, layerNow } from "./helpers/history-step";

let dir: string;
let project: string;
let userFile: string;
let projectFile: string;
// The machine each test runs on: its user config home is the test's own, and
// the worker's environment is otherwise unchanged.
let host: Host;
let world: World;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-layers-"));
  project = path.join(dir, "repo");
  fs.mkdirSync(path.join(dir, "xdg", "cc-candybar"), { recursive: true });
  fs.mkdirSync(project);
  // The project's config runs: these cases are about how it layers.
  answerRepo(project);
  userFile = path.join(dir, "xdg", "cc-candybar", "config.json5");
  projectFile = path.join(project, ".cc-candybar.json5");
  host = hostOf({ ...process.env, XDG_CONFIG_HOME: path.join(dir, "xdg") });
  world = worldOf(host);
  fs.writeFileSync(
    userFile,
    `{ globals: { menuGlyph: "U" }, segments: { mine: { template: "USERSEG" } }, root: { h: ["mine"] } }`,
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function clean(o: ConfigDraw): Extract<ConfigDraw, { kind: "clean" }> {
  if (o.kind !== "clean") throw new Error(JSON.stringify(o));
  return o;
}

// The layer of `role` a click in the project writes, in the chain discovery
// finds there under the answers the bar reads.
const projectLayer = (role: LayerRole = "user") =>
  layerNow(host, originOf(project, project), role);

test("a project file that places one segment renders over the user's whole config", async () => {
  // `mine` is declared only by the user's file: the project file loads only
  // because it is merged over it.
  fs.writeFileSync(
    projectFile,
    `{ segments: { proj: { template: "PROJSEG" } }, root: { h: ["mine", "proj"] } }`,
  );
  const outcome = clean(await renderConfig(world, undefined, project));
  expect(outcome.layers).toEqual([
    { path: userFile, role: "user" },
    { path: projectFile, role: "project" },
  ]);
  expect(textOf(outcome.rendered)).toContain("USERSEG");
  expect(textOf(outcome.rendered)).toContain("PROJSEG");
  const prepared = await prepareConfig(
    world,
    outcome.layers,
    project,
    [],
    instantOf(new Date()),
  );
  try {
    expect(prepared.config.globals.menuGlyph).toBe("U");
  } finally {
    prepared.registry.dispose();
  }
});

test("a layer that does not load fails naming its own file", async () => {
  fs.writeFileSync(projectFile, `{ root: { h: ["nowhere"] } }`);
  const outcome = await renderConfig(world, undefined, project);
  expect(outcome.kind).toBe("fatal");
  if (outcome.kind === "fatal") expect(outcome.message).toContain(projectFile);
});

test("a durable click writes the user's file, never the project's", () => {
  fs.writeFileSync(projectFile, `{ root: { h: ["mine"] } }`);
  const home = projectLayer();
  expect(home.path).toBe(userFile);
  expect(home.snapshot.chain.map(({ path, role }) => ({ path, role }))).toEqual(
    [
      { path: userFile, role: "user" },
      { path: projectFile, role: "project" },
      { path: path.join(project, ".cc-candybar.local.json5"), role: "local" },
    ],
  );
  writeValues(EDITS_IN_PLACE, home, [["palette", "nord"]]);
  expect(fs.readFileSync(userFile, "utf8")).toContain("nord");
  expect(fs.readFileSync(projectFile, "utf8")).not.toContain("nord");
});

test("a click a project layer would hide is refused, naming the layer", () => {
  fs.writeFileSync(projectFile, `{ globals: { palette: "dracula" } }`);
  const before = fs.readFileSync(userFile, "utf8");
  expect(() =>
    writeValues(EDITS_IN_PLACE, projectLayer(), [["palette", "nord"]]),
  ).toThrow(new RegExp(`${projectFile} sets globals\\.palette`));
  expect(fs.readFileSync(userFile, "utf8")).toBe(before);
});

test("a reset the project layer hides still clears the user's file", () => {
  fs.writeFileSync(
    userFile,
    `{ globals: { palette: "nord" }, segments: { mine: { template: "USERSEG" } }, root: { h: ["mine"] } }`,
  );
  fs.writeFileSync(projectFile, `{ globals: { palette: "dracula" } }`);
  deleteValues(EDITS_IN_PLACE, projectLayer(), ["palette"]);
  expect(fs.readFileSync(userFile, "utf8")).not.toContain("nord");
});

test("a click that repairs a broken user file is not refused under a project layer", () => {
  fs.writeFileSync(userFile, `{ globals: { palette: "no-such-theme" } }`);
  fs.writeFileSync(projectFile, `{ globals: { menuGlyph: "P" } }`);
  writeValues(EDITS_IN_PLACE, projectLayer(), [["palette", "nord"]]);
  expect(fs.readFileSync(userFile, "utf8")).toContain("nord");
});

test("save-as-preset never mints a name a project layer declares", () => {
  fs.writeFileSync(projectFile, `{ presets: { "custom-1": {} } }`);
  const { name } = writePreset(
    EDITS_IN_PLACE,
    projectLayer(),
    "default",
    {},
    [],
    [],
  );
  expect(name).toBe("custom-2");
});

// A file above the user's inherits what the user's file says: a structural
// edit there finds and copies the user's rows and presets, never the bundled
// default's in their place.
describe("a write to a layer above the user's", () => {
  const localFile = () => path.join(project, ".cc-candybar.local.json5");

  test("a layout edit finds the user's row and copies it, not the bundled one", () => {
    applyLayoutOp(
      EDITS_IN_PLACE,
      projectLayer("project"),
      "presets.default.root",
      {
        op: "insert",
        segment: "model",
        anchor: "mine",
        relation: "after",
      },
      () => "x1",
    );
    const written = fs.readFileSync(projectFile, "utf8");
    expect(written).toContain("mine");
    expect(written).toContain("model");
    expect(written).not.toContain("gitaculous");
  });

  test("save-as-preset copies a preset only the user's file declares", () => {
    fs.writeFileSync(
      userFile,
      `{ segments: { mine: { template: "USERSEG" } }, presets: { own: { root: { h: ["mine"] } } } }`,
    );
    const { name } = writePreset(
      EDITS_IN_PLACE,
      projectLayer("local"),
      "own",
      {},
      [],
      [],
    );
    const written = fs.readFileSync(localFile(), "utf8");
    expect(written).toContain(name);
    expect(written).toContain("mine");
  });

  test("save-as-preset never mints a name the user's file declares", () => {
    fs.writeFileSync(userFile, `{ presets: { "custom-1": {} } }`);
    expect(
      writePreset(
        EDITS_IN_PLACE,
        projectLayer("project"),
        "default",
        {},
        [],
        [],
      ).name,
    ).toBe("custom-2");
  });

  // A click that writes two layers proves each write against the files as
  // the click leaves them: a value it set in the project's file hides the
  // user's write of the same field, though the disk does not hold it yet.
  test("a later write of one click is judged against what the click's earlier write left", () => {
    const staged = new Map<string, string>();
    const click = {
      read: (file: string) =>
        contentOfText(
          staged.get(file) ??
            (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null),
        ),
      record: (file: string, _before: string | null, after: string) => {
        staged.set(file, after);
      },
    };
    writeValues(click, projectLayer("project"), [["menuGlyph", "P"]]);
    expect(fs.existsSync(projectFile)).toBe(false);
    expect(() =>
      writeValues(click, projectLayer("user"), [["menuGlyph", "Q"]]),
    ).toThrow(/would change nothing on the bar/);
  });

  test("a user-layer write refuses an unreadable neighbouring layer before recording it", () => {
    const layer = projectLayer("user");
    const before = fs.readFileSync(userFile, "utf8");
    const record = jest.fn();
    const target = layer.snapshot.chain.find(({ role }) => role === "project");
    expect(target).toBeDefined();
    expect(() =>
      writeValues(
        {
          read: (file) =>
            file === target?.path
              ? { kind: "unreadable", error: "EACCES" }
              : EDITS_IN_PLACE.read(file),
          record,
        },
        layer,
        [["menuGlyph", "Q"]],
      ),
    ).toThrow(/\.cc-candybar\.json5 could not be read \(EACCES\)/);
    expect(record).not.toHaveBeenCalled();
    expect(fs.readFileSync(userFile, "utf8")).toBe(before);
  });

  test("a write over a layer beneath that does not load is refused, naming why", () => {
    fs.writeFileSync(userFile, `{ globals: { menuGlyph: `);
    expect(() =>
      writeValues(EDITS_IN_PLACE, projectLayer("project"), [
        ["menuGlyph", "P"],
      ]),
    ).toThrow(/^refused: a layer beneath .* does not load/);
  });

  // What a file inherits is the merge of the layers beneath it, never a
  // chain with a layer taken out: a layer above that leans on the written
  // file's declarations does not refuse the write.
  test("a user write is not refused because the local file selects a preset the user's file declares", () => {
    fs.writeFileSync(
      userFile,
      `{ segments: { mine: { template: "USERSEG" } }, presets: { own: {} }, root: { h: ["mine"] } }`,
    );
    fs.writeFileSync(localFile(), `{ globals: { preset: "own" } }`);
    writeValues(EDITS_IN_PLACE, projectLayer("user"), [["menuGlyph", "Q"]]);
    expect(fs.readFileSync(userFile, "utf8")).toContain("Q");
  });
});

test("the user's file is a layer even when the session's project is its directory", () => {
  const xdgDir = path.dirname(userFile);
  const local = path.join(xdgDir, ".cc-candybar.json5");
  fs.writeFileSync(local, `{}`);
  answerRepo(xdgDir);
  const resolved = resolutionOf(
    locations(host),
    repoConfigs(stateDir(host)).read(),
    { projectDir: xdgDir },
  );
  expect(resolved.kind === "chain" && resolved.layers).toEqual([
    { path: userFile, role: "user" },
    { path: local, role: "project" },
  ]);
});

test("save-as-preset reads a layer above that the editor would refuse", () => {
  fs.writeFileSync(
    projectFile,
    `{ presets: { "custom-1": {} }, globals: { menuGlyph: "a", menuGlyph: "b" } }`,
  );
  expect(
    writePreset(EDITS_IN_PLACE, projectLayer(), "default", {}, [], []).name,
  ).toBe("custom-2");
});

// An absent user file reads as the chain's base, installed plugins included:
// an installed plugin's names are not a change the first write is hidden by.
test("a first durable write with no user file succeeds beside an installed plugin", () => {
  host = hostOf({ ...host.env, XDG_DATA_HOME: path.join(dir, "data") });
  world = worldOf(host);
  {
    fs.rmSync(userFile);
    const def = path.join(dir, "data/cc-candybar/plugins/deploy/plugin.json5");
    fs.mkdirSync(path.dirname(def), { recursive: true });
    fs.writeFileSync(
      def,
      `{ data: "./d.json", segments: { status: { template: "x" } } }`,
    );
    fs.writeFileSync(projectFile, `{ root: { h: ["plugins.deploy.status"] } }`);
    writeValues(EDITS_IN_PLACE, projectLayer(), [["palette", "nord"]]);
    expect(fs.readFileSync(userFile, "utf8")).toContain("nord");
  }
});

// A project layer's `insert` adds a cell beside a placement the user's bar
// already has, without restating the user's row.
describe("a project layer inserting into the user's row", () => {
  const userRow = (row: string, extra = "") =>
    fs.writeFileSync(
      userFile,
      `{ segments: { mine: { template: "USERSEG" }, other: { template: "OTHERSEG" }${extra} }, root: ${row} }`,
    );
  const writeProject = (
    insert: string,
    segments = `theirs: { template: "THEIRSEG" }`,
  ) =>
    fs.writeFileSync(
      projectFile,
      `{ segments: { ${segments} }, insert: ${insert} }`,
    );
  const order = (rendered: Frame, ...marks: string[]) =>
    marks.map((m) => textOf(rendered).indexOf(m));
  // The trees one insert notice names as missed: its closing `(in …)`.
  const missedTrees = (w: string) => /\(in (.*)\)$/.exec(w)?.[1] ?? "";
  // The warnings about the config's own root.
  const warnedFor = (warnings: readonly string[], entry: string) =>
    warnings.filter(
      (w) => w.includes(entry) && missedTrees(w).includes("the root"),
    );
  const presetWarnings = (warnings: readonly string[], preset: string) =>
    warnings.filter((w) => missedTrees(w).includes(`preset "${preset}"`));
  const presetTree = async (preset: string) => {
    const outcome = clean(await renderConfig(world, undefined, project));
    const prepared = await prepareConfig(
      world,
      outcome.layers,
      project,
      [],
      instantOf(new Date()),
    );
    try {
      return [
        ...walkNodes(fragmentNode(prepared.config.presets[preset]!.root!)),
      ].flatMap((n) => (n.kind === "segment" ? [n.name] : []));
    } finally {
      prepared.registry.dispose();
    }
  };

  test("a preset that already places the cell loads and draws it once", async () => {
    userRow(
      `{ rows: { status: { h: ["mine", "other"] } } }`,
      `, theirs: { template: "THEIRSEG" } }, presets: { mine2: { root: { h: ["mine", "theirs"] } }`,
    );
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    const outcome = clean(await renderConfig(world, undefined, project));
    expect(presetWarnings(outcome.warnings, "mine2")).toEqual([]);
    expect(
      (await presetTree("mine2")).filter((n) => n === "theirs"),
    ).toHaveLength(1);
  });

  test("an anchor only a preset holds is placed in that preset, with no warning for it", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(`[{ seg: "theirs", after: "burnrate" }]`);
    const outcome = clean(await renderConfig(world, undefined, project));
    expect(presetWarnings(outcome.warnings, "verbose")).toEqual([]);
    const verbose = await presetTree("verbose");
    expect(verbose.indexOf("theirs")).toBeGreaterThan(
      verbose.indexOf("burnrate"),
    );
    expect(verbose.indexOf("burnrate")).toBeGreaterThanOrEqual(0);
  });

  test("a whole-tree preset draws the cell when it holds the anchor, and warns naming itself when it does not", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(`[{ seg: "theirs", before: "directory" }]`);
    const outcome = clean(await renderConfig(world, undefined, project));
    expect(presetWarnings(outcome.warnings, "compact")).toEqual([]);
    const compact = await presetTree("compact");
    expect(compact.indexOf("theirs")).toBeGreaterThanOrEqual(0);
    expect(compact.indexOf("theirs")).toBeLessThan(
      compact.indexOf("directory"),
    );
  });

  test("a bundled-only preset that lacks the anchor does not warn; one the user authors does", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    const bundled = clean(
      await renderConfig(world, undefined, project),
    ).warnings;
    expect(bundled.filter((w) => missedTrees(w).includes("preset "))).toEqual(
      [],
    );
    expect(warnedFor(bundled, "insert.0")).toEqual([]);
    userRow(
      `{ rows: { status: { h: ["mine", "other"] } } }`,
      ` }, presets: { compact: { root: { h: ["other"] } }`,
    );
    const missed = presetWarnings(
      clean(await renderConfig(world, undefined, project)).warnings,
      "compact",
    );
    expect(missed).toHaveLength(1);
    expect(missed[0]).toContain(projectFile);
    expect(missed[0]).toContain('"mine"');
  });

  test("an approved repo's cell lands beside its anchor and the user's file is untouched", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    const before = fs.readFileSync(userFile, "utf8");
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    const outcome = clean(await renderConfig(world, undefined, project));
    const [u, t, o] = order(
      outcome.rendered,
      "USERSEG",
      "THEIRSEG",
      "OTHERSEG",
    );
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(t!);
    expect(t).toBeLessThan(o!);
    expect(warnedFor(outcome.warnings, "insert.")).toEqual([]);
    expect(fs.readFileSync(userFile, "utf8")).toBe(before);
  });

  test("an unapproved repo's cell is not drawn and its file is never named", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    answerRepo(project, "declined");
    const outcome = clean(await renderConfig(world, undefined, project));
    expect(textOf(outcome.rendered)).toContain("USERSEG");
    expect(textOf(outcome.rendered)).not.toContain("THEIRSEG");
    expect(warnedFor(outcome.warnings, projectFile)).toEqual([]);
  });

  test("an anchor the bar does not have is a warning naming the file, the cell and the anchor", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(`[{ seg: "theirs", after: "nope" }]`);
    const outcome = clean(await renderConfig(world, undefined, project));
    expect(textOf(outcome.rendered)).toContain("USERSEG");
    expect(textOf(outcome.rendered)).not.toContain("THEIRSEG");
    const warned = warnedFor(outcome.warnings, "insert.0");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(projectFile);
    expect(warned[0]).toContain('"theirs"');
    expect(warned[0]).toContain('"nope"');
  });

  test("a cell the user already places is drawn once, with no warning", async () => {
    userRow(
      `{ rows: { status: { h: ["mine", "theirs"] } } }`,
      `, theirs: { template: "THEIRSEG" }`,
    );
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    const outcome = clean(await renderConfig(world, undefined, project));
    expect(textOf(outcome.rendered).split("THEIRSEG")).toHaveLength(2);
    expect(warnedFor(outcome.warnings, "insert.0")).toEqual([]);
  });

  test("a cell whose id another segment holds is not drawn, and the warning names both", async () => {
    userRow(
      `{ rows: { status: { h: ["mine", { seg: "other", id: "theirs" }] } } }`,
    );
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    const outcome = clean(await renderConfig(world, undefined, project));
    expect(textOf(outcome.rendered)).toContain("OTHERSEG");
    expect(textOf(outcome.rendered)).not.toContain("THEIRSEG");
    const warned = warnedFor(outcome.warnings, "insert.0");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(projectFile);
    expect(warned[0]).toContain('"theirs"');
    expect(warned[0]).toContain('"other"');
  });

  test("a whole-tree user root is addressed by placement id the same way", async () => {
    userRow(`{ h: ["mine", "other"] }`);
    writeProject(`[{ seg: "theirs", before: "other" }]`);
    const outcome = clean(await renderConfig(world, undefined, project));
    const [u, t, o] = order(
      outcome.rendered,
      "USERSEG",
      "THEIRSEG",
      "OTHERSEG",
    );
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(t!);
    expect(t).toBeLessThan(o!);
  });

  test("before places to the left, and a later cell may anchor on an earlier one", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(
      `[{ seg: "theirs", before: "mine" }, { seg: "second", after: "theirs" }]`,
      `theirs: { template: "THEIRSEG" }, second: { template: "SECONDSEG" }`,
    );
    const outcome = clean(await renderConfig(world, undefined, project));
    const [t, s, u] = order(
      outcome.rendered,
      "THEIRSEG",
      "SECONDSEG",
      "USERSEG",
    );
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThan(s!);
    expect(s).toBeLessThan(u!);
  });

  test("edit mode offers no edit on an inserted cell and labels it with the file that placed it", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(`[{ seg: "theirs", before: "mine" }]`);
    const outcome = clean(await renderConfig(world, undefined, project));
    const prepared = await prepareConfig(
      world,
      outcome.layers,
      project,
      [],
      instantOf(new Date()),
    );
    try {
      const { config } = prepared;
      const nodes = [
        ...walkNodes(fragmentNode(config.presets.default!.root!)),
      ].flatMap((n) => (n.kind === "segment" ? [n] : []));
      const acts = Object.values(config.actions) as unknown as Array<
        Record<string, unknown>
      >;
      // Nothing removes, anchors on or configures the inserted placement;
      // the user's cells keep theirs.
      expect(acts.filter((a) => a.removeSegment === "theirs")).toEqual([]);
      expect(acts.filter((a) => a.anchor === "theirs")).toEqual([]);
      expect(acts.filter((a) => a.removeSegment === "mine")).toHaveLength(1);
      // The leading `+` sits before the first cell the user's file holds.
      expect(
        acts.filter((a) => a.anchor === "mine" && a.relation === "before"),
      ).toHaveLength(1);
      const cell = nodes.find((n) => n.name === "theirs")!;
      expect(cell.lead).toBeUndefined();
      expect(cell.trail).toBeUndefined();
      expect(cell.drafts).toBeUndefined();
      const label = nodes.find(
        (n) => n.name === "edit.label:theirs/default:theirs",
      )!;
      expect(label.opens).toBeUndefined();
      expect(config.segments[label.name]!.template).toBe(
        `{{ "theirs · ${path.basename(project)}/.cc-candybar.json5 insert.0" }}`,
      );
      // A layout op aimed at the inserted id writes nothing.
      const before = fs.readFileSync(userFile, "utf8");
      expect(() =>
        applyLayoutOp(
          EDITS_IN_PLACE,
          projectLayer(),
          "presets.default.root",
          {
            op: "remove",
            target: "theirs",
          },
          () => "x1",
        ),
      ).toThrow();
      expect(fs.readFileSync(userFile, "utf8")).toBe(before);
    } finally {
      prepared.registry.dispose();
    }
  });
  // The bar's own load of the chain: what it draws, and what it dropped.
  const barLoad = () => {
    const warnings: string[] = [];
    const loaded = loadChain(
      [homeLayer(userFile), { path: projectFile, role: "project" }],
      DEFAULT_DSL_CONFIG,
      { warned: (w) => warnings.push(...w.map(({ message }) => message)) },
      { locs: locations(host), cwd: project },
    );
    const drawn = (preset: string) =>
      [
        ...walkNodes(fragmentNode(loaded.config.presets[preset]!.root!)),
      ].flatMap((n) => (n.kind === "segment" ? [n.name] : []));
    return { ...loaded, warnings, drawn };
  };

  test("a repo's cell naming no declared segment is dropped and blamed on the repo's entry; the rest draws", () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(
      `[{ seg: "ghost", after: "mine" }, { seg: "theirs", after: "other" }]`,
    );
    const { dropped, drawn } = barLoad();
    expect(dropped.map((e) => [e.file, e.issues.map((i) => i.path)])).toEqual([
      [projectFile, ["insert.0"]],
    ]);
    expect(dropped[0]!.issues[0]!.message).toContain('"ghost"');
    expect(dropped[0]!.issues[0]!.line).toBe(1);
    const names = drawn("default");
    expect(names).not.toContain("ghost");
    expect(names).toEqual(expect.arrayContaining(["mine", "other", "theirs"]));
  });

  test("the user's own cell naming no declared segment is blamed on the user's entry, under a repo layer", () => {
    fs.writeFileSync(
      userFile,
      `{\n  segments: { mine: { template: "USERSEG" } },\n  root: { h: ["mine"] },\n  insert: [\n    { seg: "ghost", after: "mine" },\n  ],\n}`,
    );
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    const { dropped, drawn } = barLoad();
    expect(dropped.map((e) => [e.file, e.issues.map((i) => i.path)])).toEqual([
      [userFile, ["insert.0"]],
    ]);
    expect(dropped[0]!.issues[0]!.line).toBe(5);
    const names = drawn("default");
    expect(names).not.toContain("ghost");
    expect(names).toEqual(expect.arrayContaining(["mine", "theirs"]));
  });

  test("a cell anchored on the bar's chrome is refused at its anchor and never drawn", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(`[{ seg: "theirs", after: "candybar.menu" }]`);
    const outcome = await renderConfig(world, undefined, project);
    expect(outcome.kind).toBe("fatal");
    if (outcome.kind === "fatal") {
      expect(outcome.message).toContain(projectFile);
      expect(outcome.message).toContain("insert.0.after");
    }
    expect(() => barLoad()).toThrow(/insert\.0\.after/);
  });

  test("an inserted cell's label and another preset's editable label of the same id each read their own text", () => {
    userRow(
      `{ rows: { status: { h: ["mine", "other"] } } }`,
      `, theirs: { template: "THEIRSEG" } }, presets: { mine2: { root: { h: ["mine", "theirs"] } }`,
    );
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    const { config } = barLoad();
    const labels = (preset: string) =>
      [...walkNodes(fragmentNode(config.presets[preset]!.root!))].flatMap(
        (n) =>
          n.kind === "segment" && n.name.startsWith("edit.label:theirs")
            ? [config.segments[n.name]!.template]
            : [],
      );
    expect(labels("default")).toEqual([
      `{{ "theirs · ${path.basename(project)}/.cc-candybar.json5 insert.0" }}`,
    ]);
    expect(labels("mine2")).toEqual([`{{ "theirs" }}`]);
    // The label names the file by its directory and name, never the whole
    // path, which would outrun the bar.
    expect(labels("default")[0]).not.toContain(dir);
  });

  test("an entry whose anchor no tree holds is one warning naming every tree it missed", async () => {
    userRow(
      `{ rows: { status: { h: ["mine", "other"] } } }`,
      ` }, presets: { compact: { root: { h: ["other"] } }, wide: { root: { h: ["mine"] } }`,
    );
    writeProject(`[{ seg: "theirs", after: "nope" }]`);
    const warned = clean(
      await renderConfig(world, undefined, project),
    ).warnings.filter((w) => w.includes("insert.0"));
    expect(warned).toHaveLength(1);
    expect(missedTrees(warned[0]!)).toBe(
      'the root, preset "compact", preset "wide"',
    );
  });

  test("a rows-map preset that already places the cell loads, and every tree draws it once", () => {
    userRow(
      `{ rows: { status: { h: ["mine"] } } }`,
      `, theirs: { template: "THEIRSEG" } }, presets: { P: { root: { rows: { extra: { h: ["theirs"] } } } }`,
    );
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    const { drawn, warnings } = barLoad();
    expect(drawn("P").filter((n) => n === "theirs")).toHaveLength(1);
    expect(drawn("default").filter((n) => n === "theirs")).toHaveLength(1);
    expect(warnings.filter((w) => w.includes("insert.0"))).toEqual([]);
  });

  test("a cell without an id is satisfied by the user's placement of its segment under another id", async () => {
    userRow(
      `{ rows: { status: { h: ["mine", { seg: "theirs", id: "t2" }] } } }`,
      `, theirs: { template: "THEIRSEG" }`,
    );
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    const outcome = clean(await renderConfig(world, undefined, project));
    expect(textOf(outcome.rendered).split("THEIRSEG")).toHaveLength(2);
    expect(outcome.warnings.filter((w) => w.includes("insert.0"))).toEqual([]);
  });

  test("a cell with its own id is drawn beside a placement of its segment under another id", async () => {
    userRow(
      `{ rows: { status: { h: ["mine", "theirs"] } } }`,
      `, theirs: { template: "THEIRSEG" }`,
    );
    writeProject(`[{ seg: "theirs", id: "t2", after: "mine" }]`);
    const outcome = clean(await renderConfig(world, undefined, project));
    expect(textOf(outcome.rendered).split("THEIRSEG")).toHaveLength(3);
  });

  test("a missed anchor warns for the root only when a config file writes it", async () => {
    fs.writeFileSync(
      userFile,
      `{ segments: { mine: { template: "USERSEG" } } }`,
    );
    writeProject(`[{ seg: "theirs", after: "nope" }]`);
    const outcome = clean(await renderConfig(world, undefined, project));
    expect(warnedFor(outcome.warnings, "insert.0")).toEqual([]);
    expect(textOf(outcome.rendered)).not.toContain("THEIRSEG");
  });

  test("a cell whose id differs from the user's only in punctuation is placed beside it", () => {
    // `p-q` and `p_q` are distinct ids, so their menus hold distinct state.
    fs.writeFileSync(
      userFile,
      `{
        actions: { act: { set: "theme", from: "themes" } },
        segments: {
          mine: { template: "USERSEG" },
          m: { template: 'M {{ menu "act" "▸" "▾" }}' },
        },
        root: { rows: { status: { h: ["mine", { seg: "m", id: "p-q" }] } } },
      }`,
    );
    writeProject(
      `[{ seg: "m", id: "p_q", after: "mine" }]`,
      `x: { template: "X" }`,
    );
    const { drawn, warnings } = barLoad();
    expect(drawn("default").filter((n) => n === "m")).toHaveLength(2);
    expect(drawn("default")).toContain("mine");
    expect(warnings.filter((w) => w.includes("insert.0"))).toEqual([]);
  });

  test("an error the user's own bar has still refuses it, with or without the repo's cells", () => {
    userRow(`{ rows: { status: { h: ["mine", "other", { seg: "other" }] } } }`);
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    expect(() => barLoad()).toThrow(/2 placements with the id "other"/);
  });
});

// The chain without the layer is a config nobody wrote, so the load fails
// naming the file, and the bar keeps its last good state.
test("a layer that could not be read fails the load naming it", () => {
  fs.mkdirSync(projectFile);
  const loaded = loadDiscovered(project, project, undefined, {
    region: SAMPLE_REGION,
    clock: systemTimekeeper,
    stateDir: stateDir(host),
    locations: locations(host),
    sessionState: new SessionState(),
    gates: bareGates(),
  });
  try {
    expect(loaded.snapshot.chain.map((l) => [l.role, l.content.kind])).toEqual([
      ["user", "text"],
      ["project", "unreadable"],
      ["local", "absent"],
    ]);
    expect(loaded.kind).toBe("failed");
    expect(loaded.error).toContain(projectFile);
    expect(loaded.error).toContain("not a file");
  } finally {
    loaded.state?.registry.dispose();
  }
});
