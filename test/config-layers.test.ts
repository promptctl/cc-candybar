// brandon-plugins-ktag.8th: a project config layers over the user's config
// instead of replacing it — bundled < user < project, through the one merge —
// and a durable click writes the user's file, refusing a change a project
// layer would hide.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConfig, NO_REPO, prepareConfig, type CheckOutcome } from "../src/check";
import { durableConfig, homeLayer, loadConfigChain } from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import {
  deleteValues,
  writePreset,
  writeValues,
} from "../src/daemon/config-file-store";
import { resolveDslConfig } from "../src/config/loader/discovery";
import { instantOf } from "../src/utils/instant";
import { repoConfigs } from "../src/daemon/repo-configs";
import { answerRepo } from "./helpers/repo-approval";
import { applyLayoutOp } from "../src/daemon/config-file-store";
import { walkNodes } from "../src/config/dsl-types";
import { fragmentNode } from "../src/config/root";
import { loadConfigOnce } from "../src/doctor/cli";

let dir: string;
let project: string;
let userFile: string;
let projectFile: string;
let savedXdg: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-layers-"));
  project = path.join(dir, "repo");
  fs.mkdirSync(path.join(dir, "xdg", "cc-candybar"), { recursive: true });
  fs.mkdirSync(project);
  // The project's config runs: these cases are about how it layers.
  answerRepo(project);
  userFile = path.join(dir, "xdg", "cc-candybar", "config.json5");
  projectFile = path.join(project, ".cc-candybar.json5");
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
  fs.writeFileSync(
    userFile,
    `{ globals: { menuGlyph: "U" }, segments: { mine: { template: "USERSEG" } }, root: { h: ["mine"] } }`,
  );
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(dir, { recursive: true, force: true });
});

function clean(o: CheckOutcome): Extract<CheckOutcome, { kind: "clean" }> {
  if (o.kind !== "clean") throw new Error(JSON.stringify(o));
  return o;
}

const noRecord = { record: () => {}, logger: () => {} };

// The home a click in the project writes, under the answers the bar reads.
const projectHome = () =>
  durableConfig(repoConfigs().read(), project, project);

test("a project file that places one segment renders over the user's whole config", async () => {
  // `mine` is declared only by the user's file: the project file loads only
  // because it is merged over it.
  fs.writeFileSync(
    projectFile,
    `{ segments: { proj: { template: "PROJSEG" } }, root: { h: ["mine", "proj"] } }`,
  );
  const outcome = clean(await checkConfig(undefined, project));
  expect(outcome.layers).toEqual([
    { path: userFile, scope: "plugins" },
    { path: projectFile, scope: "repo" },
  ]);
  expect(outcome.rendered).toContain("USERSEG");
  expect(outcome.rendered).toContain("PROJSEG");
  const prepared = await prepareConfig(outcome.layers, NO_REPO, project, [], instantOf(new Date()));
  try {
    expect(prepared.config.globals.menuGlyph).toBe("U");
  } finally {
    prepared.registry.dispose();
  }
});

test("a layer that does not load fails naming its own file", async () => {
  fs.writeFileSync(projectFile, `{ root: { h: ["nowhere"] } }`);
  const outcome = await checkConfig(undefined, project);
  expect(outcome.kind).toBe("fatal");
  if (outcome.kind === "fatal") expect(outcome.message).toContain(projectFile);
});

test("a durable click writes the user's file, never the project's", () => {
  fs.writeFileSync(projectFile, `{ root: { h: ["mine"] } }`);
  const home = projectHome();
  expect(home).toEqual({ path: userFile, above: [{ path: projectFile, scope: "repo" }], repo: project, cwd: project });
  writeValues(noRecord, home, [["palette", "nord"]]);
  expect(fs.readFileSync(userFile, "utf8")).toContain("nord");
  expect(fs.readFileSync(projectFile, "utf8")).not.toContain("nord");
});

test("a click a project layer would hide is refused, naming the layer", () => {
  fs.writeFileSync(projectFile, `{ globals: { palette: "dracula" } }`);
  const before = fs.readFileSync(userFile, "utf8");
  expect(() =>
    writeValues(noRecord, projectHome(), [["palette", "nord"]]),
  ).toThrow(new RegExp(`${projectFile} sets globals\\.palette`));
  expect(fs.readFileSync(userFile, "utf8")).toBe(before);
});

test("a reset the project layer hides still clears the user's file", () => {
  fs.writeFileSync(
    userFile,
    `{ globals: { palette: "nord" }, segments: { mine: { template: "USERSEG" } }, root: { h: ["mine"] } }`,
  );
  fs.writeFileSync(projectFile, `{ globals: { palette: "dracula" } }`);
  deleteValues(noRecord, projectHome(), ["palette"]);
  expect(fs.readFileSync(userFile, "utf8")).not.toContain("nord");
});

test("a click that repairs a broken user file is not refused under a project layer", () => {
  fs.writeFileSync(userFile, `{ globals: { palette: "no-such-theme" } }`);
  fs.writeFileSync(projectFile, `{ globals: { menuGlyph: "P" } }`);
  writeValues(noRecord, projectHome(), [["palette", "nord"]]);
  expect(fs.readFileSync(userFile, "utf8")).toContain("nord");
});

test("save-as-preset never mints a name a project layer declares", () => {
  fs.writeFileSync(projectFile, `{ presets: { "custom-1": {} } }`);
  const name = writePreset(
    noRecord,
    projectHome(),
    "default",
    {},
    [],
    [],
  );
  expect(name).toBe("custom-2");
});

test("the user's file is a layer even when the session's cwd is its directory", () => {
  const xdgDir = path.dirname(userFile);
  const local = path.join(xdgDir, ".cc-candybar.json5");
  fs.writeFileSync(local, `{}`);
  answerRepo(xdgDir);
  const resolved = resolveDslConfig(repoConfigs().read(), undefined, xdgDir);
  expect(resolved.kind === "chain" && resolved.layers).toEqual([
    { path: userFile, scope: "plugins" },
    { path: local, scope: "repo" },
  ]);
});

test("save-as-preset reads a layer above that the editor would refuse", () => {
  fs.writeFileSync(
    projectFile,
    `{ presets: { "custom-1": {} }, globals: { menuGlyph: "a", menuGlyph: "b" } }`,
  );
  expect(
    writePreset(noRecord, projectHome(), "default", {}, [], []),
  ).toBe("custom-2");
});

// An absent user file reads as the chain's base, installed plugins included:
// an installed plugin's names are not a change the first write is hidden by.
test("a first durable write with no user file succeeds beside an installed plugin", () => {
  const saved = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(dir, "data");
  try {
    fs.rmSync(userFile);
    const def = path.join(dir, "data/cc-candybar/plugins/deploy/plugin.json5");
    fs.mkdirSync(path.dirname(def), { recursive: true });
    fs.writeFileSync(def, `{ data: "./d.json", segments: { status: { template: "x" } } }`);
    fs.writeFileSync(projectFile, `{ root: { h: ["plugins.deploy.status"] } }`);
    writeValues(noRecord, projectHome(), [["palette", "nord"]]);
    expect(fs.readFileSync(userFile, "utf8")).toContain("nord");
  } finally {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
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
  const order = (rendered: string, ...marks: string[]) =>
    marks.map((m) => rendered.indexOf(m));
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
    const outcome = clean(await checkConfig(undefined, project));
    const prepared = await prepareConfig(
      outcome.layers,
      NO_REPO,
      project,
      [],
      instantOf(new Date()),
    );
    try {
      return [...walkNodes(fragmentNode(prepared.config.presets[preset]!.root!))]
        .flatMap((n) => (n.kind === "segment" ? [n.name] : []));
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
    const outcome = clean(await checkConfig(undefined, project));
    expect(presetWarnings(outcome.warnings, "mine2")).toEqual([]);
    expect(
      (await presetTree("mine2")).filter((n) => n === "theirs"),
    ).toHaveLength(1);
  });

  test("an anchor only a preset holds is placed in that preset, with no warning for it", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(`[{ seg: "theirs", after: "burnrate" }]`);
    const outcome = clean(await checkConfig(undefined, project));
    expect(presetWarnings(outcome.warnings, "verbose")).toEqual([]);
    const verbose = await presetTree("verbose");
    expect(verbose.indexOf("theirs")).toBeGreaterThan(verbose.indexOf("burnrate"));
    expect(verbose.indexOf("burnrate")).toBeGreaterThanOrEqual(0);
  });

  test("a whole-tree preset draws the cell when it holds the anchor, and warns naming itself when it does not", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(`[{ seg: "theirs", before: "gitaculous" }]`);
    const outcome = clean(await checkConfig(undefined, project));
    expect(presetWarnings(outcome.warnings, "compact")).toEqual([]);
    const compact = await presetTree("compact");
    expect(compact.indexOf("theirs")).toBeGreaterThanOrEqual(0);
    expect(compact.indexOf("theirs")).toBeLessThan(compact.indexOf("gitaculous"));
  });

  test("a bundled-only preset that lacks the anchor does not warn; one the user authors does", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    const bundled = clean(await checkConfig(undefined, project)).warnings;
    expect(bundled.filter((w) => missedTrees(w).includes("preset "))).toEqual([]);
    expect(warnedFor(bundled, "insert.0")).toEqual([]);
    userRow(
      `{ rows: { status: { h: ["mine", "other"] } } }`,
      ` }, presets: { compact: { root: { h: ["other"] } }`,
    );
    const missed = presetWarnings(
      clean(await checkConfig(undefined, project)).warnings,
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
    const outcome = clean(await checkConfig(undefined, project));
    const [u, t, o] = order(outcome.rendered, "USERSEG", "THEIRSEG", "OTHERSEG");
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
    const outcome = clean(await checkConfig(undefined, project));
    expect(outcome.rendered).toContain("USERSEG");
    expect(outcome.rendered).not.toContain("THEIRSEG");
    expect(warnedFor(outcome.warnings, projectFile)).toEqual([]);
  });

  test("an anchor the bar does not have is a warning naming the file, the cell and the anchor", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(`[{ seg: "theirs", after: "nope" }]`);
    const outcome = clean(await checkConfig(undefined, project));
    expect(outcome.rendered).toContain("USERSEG");
    expect(outcome.rendered).not.toContain("THEIRSEG");
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
    const outcome = clean(await checkConfig(undefined, project));
    expect(outcome.rendered.split("THEIRSEG")).toHaveLength(2);
    expect(warnedFor(outcome.warnings, "insert.0")).toEqual([]);
  });

  test("a cell whose id another segment holds is not drawn, and the warning names both", async () => {
    userRow(
      `{ rows: { status: { h: ["mine", { seg: "other", id: "theirs" }] } } }`,
    );
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    const outcome = clean(await checkConfig(undefined, project));
    expect(outcome.rendered).toContain("OTHERSEG");
    expect(outcome.rendered).not.toContain("THEIRSEG");
    const warned = warnedFor(outcome.warnings, "insert.0");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(projectFile);
    expect(warned[0]).toContain('"theirs"');
    expect(warned[0]).toContain('"other"');
  });

  test("a whole-tree user root is addressed by placement id the same way", async () => {
    userRow(`{ h: ["mine", "other"] }`);
    writeProject(`[{ seg: "theirs", before: "other" }]`);
    const outcome = clean(await checkConfig(undefined, project));
    const [u, t, o] = order(outcome.rendered, "USERSEG", "THEIRSEG", "OTHERSEG");
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
    const outcome = clean(await checkConfig(undefined, project));
    const [t, s, u] = order(outcome.rendered, "THEIRSEG", "SECONDSEG", "USERSEG");
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThan(s!);
    expect(s).toBeLessThan(u!);
  });

  test("edit mode offers no edit on an inserted cell and labels it with the file that placed it", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(`[{ seg: "theirs", before: "mine" }]`);
    const outcome = clean(await checkConfig(undefined, project));
    const prepared = await prepareConfig(
      outcome.layers,
      NO_REPO,
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
        applyLayoutOp(noRecord, projectHome(), "presets.default.root", {
          op: "remove",
          target: "theirs",
        }),
      ).toThrow();
      expect(fs.readFileSync(userFile, "utf8")).toBe(before);
    } finally {
      prepared.registry.dispose();
    }
  });
  // The bar's own load of the chain: what it draws, and what it dropped.
  const barLoad = () => {
    const warnings: string[] = [];
    const loaded = loadConfigChain(
      [homeLayer(userFile), { path: projectFile, scope: "repo" }],
      DEFAULT_DSL_CONFIG,
      { warned: (w) => warnings.push(...w) },
      { repo: null, cwd: project },
    );
    const drawn = (preset: string) =>
      [...walkNodes(fragmentNode(loaded.config.presets[preset]!.root!))]
        .flatMap((n) => (n.kind === "segment" ? [n.name] : []));
    return { ...loaded, warnings, drawn };
  };

  test("a repo's cell naming no declared segment is dropped and blamed on the repo's entry; the rest draws", () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    writeProject(`[{ seg: "ghost", after: "mine" }, { seg: "theirs", after: "other" }]`);
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
    const outcome = await checkConfig(undefined, project);
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
      [...walkNodes(fragmentNode(config.presets[preset]!.root!))].flatMap((n) =>
        n.kind === "segment" && n.name.startsWith("edit.label:theirs")
          ? [config.segments[n.name]!.template]
          : [],
      );
    expect(labels("default")).toEqual([`{{ "theirs · ${path.basename(project)}/.cc-candybar.json5 insert.0" }}`]);
    expect(labels("mine2")).toEqual([`{{ "theirs" }}`]);
    // The label names the file by its directory and name, never the whole
    // path, which would outrun the bar.
    expect(labels("default")[0]).not.toContain(dir);
  });

  test("a segment only an insert entry places, and the variable it reads, are not reported unused", () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    fs.writeFileSync(
      projectFile,
      `{
        variables: { tv: { kind: "literal", value: "x" } },
        segments: { theirs: { template: "{{ .tv }}" }, spare: { template: "S" } },
        insert: [{ seg: "theirs", after: "mine" }],
      }`,
    );
    const { unused } = loadConfigOnce({
      projectDir: project,
      cwd: project,
      target: { source: "search" },
    });
    expect(unused.map((u) => `${u.kind} ${u.name}`)).toEqual(["segment spare"]);
  });

  test("an entry whose anchor no tree holds is one warning naming every tree it missed", async () => {
    userRow(
      `{ rows: { status: { h: ["mine", "other"] } } }`,
      ` }, presets: { compact: { root: { h: ["other"] } }, wide: { root: { h: ["mine"] } }`,
    );
    writeProject(`[{ seg: "theirs", after: "nope" }]`);
    const warned = clean(await checkConfig(undefined, project)).warnings.filter(
      (w) => w.includes("insert.0"),
    );
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
    const outcome = clean(await checkConfig(undefined, project));
    expect(outcome.rendered.split("THEIRSEG")).toHaveLength(2);
    expect(outcome.warnings.filter((w) => w.includes("insert.0"))).toEqual([]);
  });

  test("a cell with its own id is drawn beside a placement of its segment under another id", async () => {
    userRow(
      `{ rows: { status: { h: ["mine", "theirs"] } } }`,
      `, theirs: { template: "THEIRSEG" }`,
    );
    writeProject(`[{ seg: "theirs", id: "t2", after: "mine" }]`);
    const outcome = clean(await checkConfig(undefined, project));
    expect(outcome.rendered.split("THEIRSEG")).toHaveLength(3);
  });

  test("a missed anchor warns for the root only when a config file writes it", async () => {
    fs.writeFileSync(
      userFile,
      `{ segments: { mine: { template: "USERSEG" } } }`,
    );
    writeProject(`[{ seg: "theirs", after: "nope" }]`);
    const outcome = clean(await checkConfig(undefined, project));
    expect(warnedFor(outcome.warnings, "insert.0")).toEqual([]);
    expect(outcome.rendered).not.toContain("THEIRSEG");
  });

  test("a clash only the cell brings refuses the cell, at its entry, and the user's bar draws", () => {
    // `p-q` and `p_q` are distinct ids whose menus collapse to one state
    // key: the clash exists only once the repo's cell is placed.
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
    writeProject(`[{ seg: "m", id: "p_q", after: "mine" }]`, `x: { template: "X" }`);
    const { drawn, warnings } = barLoad();
    expect(drawn("default").filter((n) => n === "m")).toHaveLength(1);
    expect(drawn("default")).toContain("mine");
    const refused = warnings.filter((w) => w.includes("insert.0"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain(projectFile);
    expect(refused[0]).toContain("normalize to the same state key");
  });

  test("an error the user's own bar has still refuses it, with or without the repo's cells", () => {
    userRow(`{ rows: { status: { h: ["mine", "other", { seg: "other" }] } } }`);
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    expect(() => barLoad()).toThrow(/2 placements with the id "other"/);
  });
});
