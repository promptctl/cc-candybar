// [LAW:behavior-not-structure] A session's config load is a value built over
// the disk it is handed: the chain, the gate, the advisories and the parsed
// config, with no daemon and nothing read but through that disk.

import path from "node:path";
import {
  filesystemFake,
  type FilesystemFake,
} from "../../src/disk/filesystem-fake";
import type { FilesystemReads } from "../../src/disk/filesystem";
import { heldClock } from "../helpers/held-clock";
import { InstalledLayerMemo } from "../../src/config/dsl-loader";
import { readConfigLoad, type ConfigLoad } from "../../src/config/load";
import { repoConfigsPath } from "../../src/config/loader/repo-book";
import type { Locations } from "../../src/daemon/paths";

const root = "/w";
const project = path.join(root, "repo");
const state = path.join(root, "state");
const locs: Locations = {
  homeDir: path.join(root, "home"),
  configDir: path.join(root, "xdg", "cc-candybar"),
  dataHome: path.join(root, "data"),
  dataDirs: [],
};
const userFile = path.join(locs.configDir, "config.json5");
const projectFile = path.join(project, ".cc-candybar.json5");
const installed = (name: string): string =>
  path.join(locs.dataHome, "cc-candybar", "plugins", name, "plugin.json5");

let disk: FilesystemFake;
beforeEach(() => {
  disk = filesystemFake({ clock: heldClock(new Date(0)), platform: "darwin" });
  disk.mkdir(project);
});

function file(at: string, text: string): void {
  disk.mkdir(path.dirname(at));
  disk.write(at, text);
}

const approve = (dir: string): void =>
  file(repoConfigsPath(state), JSON.stringify({ [dir]: "approved" }));

const load = (
  reads: FilesystemReads = disk,
  memo = new InstalledLayerMemo(),
): ConfigLoad =>
  readConfigLoad(reads, {
    locations: locs,
    stateDir: state,
    projectDir: project,
    cwd: project,
    configFile: undefined,
    memo,
  });

const parsed = (l: ConfigLoad) => {
  if (l.parsed.kind !== "parsed") throw l.parsed.cause;
  return l.parsed.loaded;
};

const template = (l: ConfigLoad, segment: string): unknown =>
  parsed(l).config.segments[segment]?.template;

test("an approved project file layers over the user's, over an installed and a listed plugin", () => {
  file(installed("inst"), `{ segments: { s: { template: "INST" } } }`);
  file(
    path.join(locs.configDir, "lp", "plugin.json5"),
    `{ segments: { s: { template: "LISTED" } } }`,
  );
  file(
    userFile,
    `{ plugins: ["./lp/plugin.json5"], segments: { u: { template: "USER" } } }`,
  );
  file(projectFile, `{ segments: { u: { template: "PROJECT" } } }`);
  approve(project);

  const l = load();
  expect(l.chain.layers).toEqual([
    { path: userFile, scope: "plugins" },
    { path: projectFile, scope: "repo" },
  ]);
  expect(l.repos.approved).toEqual([project]);
  expect(l.advisories.filter((a) => a !== null)).toEqual([]);
  expect(template(l, "u")).toBe("PROJECT");
  expect(template(l, "plugins.inst.s")).toBe("INST");
  expect(template(l, "plugins.lp.s")).toBe("LISTED");
});

test("an unanswered repository is no layer, and the gate names it awaiting", () => {
  file(projectFile, `{ segments: { u: { template: "PROJECT" } } }`);
  const l = load();
  expect(l.chain.layers).toEqual([]);
  expect(l.repos.awaiting).toEqual([project]);
  expect(template(l, "u")).toBeUndefined();
});

test("a definition that cannot be read drops, naming what the disk said", () => {
  file(installed("locked"), `{ segments: { s: { template: "X" } } }`);
  disk.fault(installed("locked"), "EACCES");
  file(userFile, `{ root: { h: ["plugins.locked.s"] } }`);
  const dropped = parsed(load()).installed.dropped;
  expect(dropped.map((d) => [d.path, d.reason])).toEqual([
    [installed("locked"), expect.stringContaining("EACCES")],
  ]);
});

test("a book that cannot be read is the unread advisory", () => {
  file(repoConfigsPath(state), "not json");
  const l = load();
  expect(l.repos.unread).toContain("is not JSON");
  expect(l.advisories.filter((a) => a !== null)).toEqual([
    expect.stringContaining("is not JSON"),
  ]);
});

test("a .json beside a .json5 is the collision advisory", () => {
  file(userFile, "{}");
  file(userFile.replace(/\.json5$/, ".json"), "{}");
  expect(load().advisories.filter((a) => a !== null)).toEqual([
    expect.stringContaining("config-extension collision"),
  ]);
});

test("a top layer that does not load is the failed arm, blamed on its file, with the advisories it earned first", () => {
  file(
    userFile,
    `{ segments: { t: { template: "dup" }, t: { template: '{{ action "nope" "x" }}' } }, root: { h: ["t"] } }`,
  );
  const l = load();
  expect(l.parsed.kind).toBe("failed");
  if (l.parsed.kind !== "failed") return;
  expect(String(l.parsed.cause)).toContain(userFile);
  expect(l.parsed.warnings).toEqual([
    expect.stringContaining(
      `${userFile}:1: duplicate key "t" — the settings menu cannot edit this file`,
    ),
  ]);
});

describe("the installed layer's memo", () => {
  test("a definition rewritten at the same length between two loads is merged again", () => {
    const memo = new InstalledLayerMemo();
    file(installed("p"), `{ segments: { s: { template: "AAAA" } } }`);
    expect(template(load(disk, memo), "plugins.p.s")).toBe("AAAA");
    // The held clock and an in-place write keep its inode, size and mtime.
    disk.write(installed("p"), `{ segments: { s: { template: "BBBB" } } }`);
    expect(template(load(disk, memo), "plugins.p.s")).toBe("BBBB");
  });

  test("reads each definition once per load", () => {
    file(installed("p"), `{ segments: { s: { template: "AAAA" } } }`);
    const reads: string[] = [];
    const counted: FilesystemReads = {
      readFileSync: (at) => (reads.push(at), disk.readFileSync(at)),
      readdirSync: (at) => disk.readdirSync(at),
      statSync: (at) => disk.statSync(at),
      lstatSync: (at) => disk.lstatSync(at),
      realpathSync: (at) => disk.realpathSync(at),
    };
    load(counted);
    expect(reads.filter((at) => at === installed("p"))).toEqual([
      installed("p"),
    ]);
  });
});
