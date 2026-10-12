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
  const prepared = await prepareConfig(outcome.layers, project, []);
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
  const home = durableConfig(project, project);
  expect(home).toEqual({ path: userFile, above: [projectFile] });
  writeValues(noRecord, home, [["palette", "nord"]]);
  expect(fs.readFileSync(userFile, "utf8")).toContain("nord");
  expect(fs.readFileSync(projectFile, "utf8")).not.toContain("nord");
});

test("a click a project layer would hide is refused, naming the layer", () => {
  fs.writeFileSync(projectFile, `{ globals: { palette: "dracula" } }`);
  const before = fs.readFileSync(userFile, "utf8");
  expect(() =>
    writeValues(noRecord, durableConfig(project, project), [["palette", "nord"]]),
  ).toThrow(new RegExp(`${projectFile} sets globals\\.palette`));
  expect(fs.readFileSync(userFile, "utf8")).toBe(before);
});

test("a reset the project layer hides still clears the user's file", () => {
  fs.writeFileSync(
    userFile,
    `{ globals: { palette: "nord" }, segments: { mine: { template: "USERSEG" } }, root: { h: ["mine"] } }`,
  );
  fs.writeFileSync(projectFile, `{ globals: { palette: "dracula" } }`);
  deleteValues(noRecord, durableConfig(project, project), ["palette"]);
  expect(fs.readFileSync(userFile, "utf8")).not.toContain("nord");
});

test("a click that repairs a broken user file is not refused under a project layer", () => {
  fs.writeFileSync(userFile, `{ globals: { palette: "no-such-theme" } }`);
  fs.writeFileSync(projectFile, `{ globals: { menuGlyph: "P" } }`);
  writeValues(noRecord, durableConfig(project, project), [["palette", "nord"]]);
  expect(fs.readFileSync(userFile, "utf8")).toContain("nord");
});

test("save-as-preset never mints a name a project layer declares", () => {
  fs.writeFileSync(projectFile, `{ presets: { "custom-1": {} } }`);
  const name = writePreset(
    noRecord,
    durableConfig(project, project),
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
  const resolved = resolveDslConfig(undefined, xdgDir);
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
    writePreset(noRecord, durableConfig(project, project), "default", {}, [], []),
  ).toBe("custom-2");
});
