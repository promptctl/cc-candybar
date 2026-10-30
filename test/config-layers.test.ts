// brandon-plugins-ktag.8th: a project config layers over the user's config
// instead of replacing it — bundled < user < project, through the one merge —
// and a durable click writes the user's file, refusing a change a project
// layer would hide.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConfig, prepareConfig, type CheckOutcome } from "../src/check";
import { durableConfig } from "../src/config/dsl-loader";
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
  expect(outcome.layers).toEqual([userFile, projectFile]);
  expect(outcome.rendered).toContain("USERSEG");
  expect(outcome.rendered).toContain("PROJSEG");
  const prepared = await prepareConfig(outcome.layers, null, project, [], instantOf(new Date()));
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
  expect(home).toEqual({ path: userFile, above: [projectFile], repo: project, cwd: project });
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
    userFile,
    local,
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
  const warnedFor = (warnings: readonly string[], entry: string) =>
    warnings.filter((w) => w.includes(entry));

  test("an approved repo's cell lands beside its anchor and the user's file is untouched", async () => {
    userRow(`{ rows: { status: { h: ["mine", "other"] } } }`);
    const before = fs.readFileSync(userFile, "utf8");
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    const outcome = clean(await checkConfig(undefined, project));
    const [u, t, o] = order(outcome.rendered, "USERSEG", "THEIRSEG", "OTHERSEG");
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(t!);
    expect(t).toBeLessThan(o!);
    expect(warnedFor(outcome.warnings, "insert[")).toEqual([]);
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
    const warned = warnedFor(outcome.warnings, "insert[0]");
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
    expect(warnedFor(outcome.warnings, "insert[0]")).toEqual([]);
  });

  test("a cell whose id another segment holds is not drawn, and the warning names both", async () => {
    userRow(
      `{ rows: { status: { h: ["mine", { seg: "other", id: "theirs" }] } } }`,
    );
    writeProject(`[{ seg: "theirs", after: "mine" }]`);
    const outcome = clean(await checkConfig(undefined, project));
    expect(outcome.rendered).toContain("OTHERSEG");
    expect(outcome.rendered).not.toContain("THEIRSEG");
    const warned = warnedFor(outcome.warnings, "insert[0]");
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
      null,
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
      const label = nodes.find((n) => n.name === "edit.label:theirs:theirs")!;
      expect(label.opens).toBeUndefined();
      expect(config.segments[label.name]!.template).toBe(
        `{{ "theirs · ${outcome.layers[1]} insert[0]" }}`,
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
});
