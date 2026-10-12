// [LAW:behavior-not-structure] A plugin, end to end, as the two programs that
// meet it see it: `cc-candybar check` (the verdict an authoring agent reads)
// and the loaded config's live variable store (what the daemon renders from).
// brandon-plugins-ktag.8fv.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConfig, prepareConfig, type CheckOutcome } from "../src/check";
import { addableSegmentDomains } from "../src/config/edit-chrome";
import { stripAnsi } from "./helpers/daemon-e2e";
import { loadFromDisk, RenderCache } from "../src/daemon/cache/render";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { pluginRoots } from "../src/config/loader/plugin-folders";
import { hasCacheField } from "../src/config/dsl-types";
import { GitDataProvider } from "../src/daemon/cache/git";
import { SessionState } from "../src/daemon/session-state";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugins-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, contents: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
  return p;
}

const DEFINITION = `{
  data: "./state.json",
  segments: {
    status: {
      when: '{{ hasKey .plugins.deploy.data "env" }}',
      template: '⇪ {{ .plugins.deploy.data.env }} {{ template "plugins.deploy.state" .plugins.deploy.data }}',
    },
  },
  helpers: { state: '{{ .state }}' },
}`;

// The config lists the plugin from a subdirectory, so the definition's path
// resolves against the listing file and the data path against the definition;
// the folder names the plugin.
function config(definition = DEFINITION): string {
  write("deploy/plugin.json5", definition);
  return write(
    "config.json5",
    `{ plugins: ["./deploy/plugin.json5"], root: { h: ["plugins.deploy.status"] } }`,
  );
}

function clean(o: CheckOutcome): { rendered: string; warnings: readonly string[] } {
  if (o.kind !== "clean") throw new Error(`expected clean, got ${JSON.stringify(o)}`);
  return { rendered: stripAnsi(o.rendered), warnings: o.warnings };
}

function fatal(o: CheckOutcome): string {
  if (o.kind !== "fatal") throw new Error(`expected fatal, got ${JSON.stringify(o)}`);
  return [o.message, ...o.warnings].join("\n");
}

describe("a listed plugin", () => {
  test("renders its segment from its data file", async () => {
    const p = config();
    write("deploy/state.json", `{ "env": "prod", "state": "live" }`);
    const { rendered, warnings } = clean(await checkConfig(p, dir));
    expect(rendered).toContain("⇪ prod live");
    expect(warnings).toEqual([]);
  });

  test("a missing data file reads as no fields, so a `when` hides the segment", async () => {
    const { rendered } = clean(await checkConfig(config(), dir));
    expect(rendered).not.toContain("⇪");
  });

  test("malformed data is the segment's ⚠ and fails check", async () => {
    const p = config();
    write("deploy/state.json", `{ "env": `);
    const message = fatal(await checkConfig(p, dir));
    expect(message).toContain('segment "plugins.deploy.status"');
    expect(message).toContain("JSON parse failed");
  });

  test("its segments join the add-segment library", async () => {
    const warnings: string[] = [];
    const prepared = await prepareConfig([config()], dir, warnings);
    try {
      const members = [...addableSegmentDomains(prepared.config).values()][0]!.members;
      expect(members).toContain("plugins.deploy.status");
    } finally {
      prepared.registry.dispose();
    }
  });

  test("a data rewrite changes what the bar reads, without a reload", async () => {
    const p = config();
    const data = write("deploy/state.json", `{ "env": "prod", "state": "rolling" }`);
    const prepared = await prepareConfig([p], dir, []);
    try {
      const read = () => prepared.store.readDocument("plugins.deploy.data");
      expect(read()).toEqual({ kind: "ok", value: { env: "prod", state: "rolling" } });
      // fs.watch attaches asynchronously and has no ready signal, so the
      // (idempotent) rewrite repeats until the watcher delivers it.
      const next = `{ "env": "prod", "state": "live" }`;
      for (let i = 0; i < 100; i++) {
        fs.writeFileSync(data, next);
        await new Promise((r) => setTimeout(r, 50));
        if ((read() as { value?: { state?: string } }).value?.state === "live") break;
      }
      expect(read()).toEqual({ kind: "ok", value: { env: "prod", state: "live" } });
    } finally {
      prepared.registry.dispose();
    }
  });
});

describe("a plugin that does not load is dropped alone", () => {
  // The rest of the config still renders, the drop is a warning on the strip,
  // and check fails naming the definition.
  async function dropped(definition: string, expected: string, folder = "x"): Promise<void> {
    write(`${folder}/plugin.json5`, definition);
    const p = write(
      "config.json5",
      `{ plugins: ["./${folder}/plugin.json5"], segments: { mine: { template: "mine" } }, root: { h: ["mine"] } }`,
    );
    const message = fatal(await checkConfig(p, dir));
    expect(message).toContain(`plugin ${path.join(dir, folder, "plugin.json5")} was not loaded`);
    expect(message).toContain(expected);
  }

  test("a definition declaring a source of its own", () =>
    dropped(
      `{ data: "./d.json", segments: {}, variables: { y: { kind: "shell", command: "true", cache: { never: true } } } }`,
      `a plugin definition may not declare "variables"`,
    ));

  test("a definition editing root", () =>
    dropped(`{ data: "./d.json", segments: {}, root: { h: [] } }`, `may not declare "root"`));

  test("a folder whose name is not one identifier", () =>
    dropped(`{ data: "./d.json", segments: {} }`, `its folder "a.b" is not a plugin name`, "a.b"));

  test("a definition naming itself: the folder is the name", () =>
    dropped(`{ plugin: "x", data: "./d.json", segments: {} }`, `its name is its folder's ("x") — remove "plugin"`));


  test("a template naming something nothing declares", () =>
    dropped(`{ data: "./d.json", segments: { s: { template: "{{ .nope.y }}" } } }`, "nope"));

  test("an action whose do names an action nothing declares", () =>
    dropped(
      `{ data: "./d.json", actions: { a: { set: "k", to: "1" }, go: { do: ["plugins.x.a", "nope"] } }, segments: { s: { template: "x" } } }`,
      `references unknown action "nope"`,
    ));

  test("a segment declaring vars of its own (a source)", () =>
    dropped(
      `{ data: "./d.json", segments: { s: { template: "x", vars: { p: { kind: "shell", command: "true", cache: { never: true } } } } } }`,
      `may not declare "vars"`,
    ));

  test("a template that does not parse", () =>
    dropped(
      `{ data: "./d.json", segments: { s: { template: "{{ if .x.data }}x" } } }`,
      "Template parse error in segments.plugins.x.s.template",
    ));

  test("a definition that is not there", () =>
    dropped(`{ data: "./d.json", segments: {} }`.replace(/.*/s, "{ "), "JSON5"));
});

test("the user's config still renders beside a dropped plugin", async () => {
  write("x/plugin.json5", `{}`);
  const p = write(
    "config.json5",
    `{ plugins: ["./x/plugin.json5"], segments: { mine: { template: "mine-here" } }, root: { h: ["mine"] } }`,
  );
  const warnings: string[] = [];
  const prepared = await prepareConfig([p], dir, warnings);
  try {
    expect(prepared.config.segments.mine).toBeDefined();
    expect(prepared.droppedPlugins).toHaveLength(1);
    expect(warnings.join("\n")).toContain("was not loaded");
  } finally {
    prepared.registry.dispose();
  }
});

test("a plugin named like the bar's own namespaces lives under plugins., beside them", async () => {
  write("candybar/plugin.json5", `{ data: "./d.json", segments: { s: { template: "mine" } } }`);
  const p = write("config.json5", `{ plugins: ["./candybar/plugin.json5"], root: { h: ["plugins.candybar.s"] } }`);
  expect(clean(await checkConfig(p, dir)).rendered).toContain("mine");
});

describe("a placed segment of a dropped plugin stands in as a cell, not a broken config", () => {
  async function placed(definition: string | null): Promise<string> {
    if (definition !== null) write("deploy/plugin.json5", definition);
    const p = write(
      "config.json5",
      `{ plugins: ["./deploy/plugin.json5"], segments: { mine: { template: "mine-here" } }, root: { h: ["mine", "plugins.deploy.status"] } }`,
    );
    const warnings: string[] = [];
    const prepared = await prepareConfig([p], dir, warnings);
    try {
      expect(prepared.droppedPlugins).toHaveLength(1);
      return prepared.config.segments["plugins.deploy.status"]!.template!;
    } finally {
      prepared.registry.dispose();
    }
  }

  const notice = () => `plugins.deploy.status: plugin ${path.join(dir, "deploy/plugin.json5")} was not loaded`;

  test("when the definition does not load", async () => {
    expect(await placed(`{ data: "./d.json", segments: { status: { template: "{{ if }}" } } }`)).toContain(notice());
  });

  test("when the definition could not be read at all", async () => {
    expect(await placed(null)).toContain(notice());
  });

  test("and check still fails, naming the drop", async () => {
    const p = write(
      "config.json5",
      `{ plugins: ["./deploy/plugin.json5"], root: { h: ["plugins.deploy.status"] } }`,
    );
    const message = fatal(await checkConfig(p, dir));
    expect(message).toContain("1 plugin did not load");
    expect(message).not.toContain("render error");
  });

  test("a by-field retune and placement settings still load", async () => {
    const p = write(
      "config.json5",
      `{ plugins: ["./deploy/plugin.json5"],
         segments: { "plugins.deploy.status": { palette: "nord" } },
         root: { h: [{ seg: "plugins.deploy.status", settings: { compact: true } }, { seg: "plugins.deploy.status", id: "two", settings: { compact: false } }] } }`,
    );
    const prepared = await prepareConfig([p], dir, []);
    try {
      expect(prepared.config.segments["plugins.deploy.status"]!.template).toContain("was not loaded");
    } finally {
      prepared.registry.dispose();
    }
  });

  test("the user's own dotted names and groups are never blamed on a drop", async () => {
    const p = write(
      "config.json5",
      `{ plugins: ["./deploy/plugin.json5"],
         segments: { "my.clock": { template: "tick" } },
         root: { h: [{ kind: "group", name: "extra", label: "x", children: ["my.clock"] }] } }`,
    );
    const prepared = await prepareConfig([p], dir, []);
    try {
      expect(prepared.config.segments["my.clock"]!.template).toBe("tick");
      expect(prepared.config.segments["groups.extra"]!.template).not.toContain("plugin not loaded");
    } finally {
      prepared.registry.dispose();
    }
  });

  test("a misspelt name under a plugin that loaded is still a load error", async () => {
    write("deploy/plugin.json5", DEFINITION);
    const p = write("config.json5", `{ plugins: ["./deploy/plugin.json5"], root: { h: ["plugins.deploy.statsu"] } }`);
    expect(fatal(await checkConfig(p, dir))).toContain(`"plugins.deploy.statsu" does not match any declared segment`);
  });
});

test("the user's file retunes a plugin segment by field", async () => {
  write("deploy/plugin.json5", DEFINITION);
  write("deploy/state.json", `{ "env": "prod", "state": "live" }`);
  const p = write(
    "config.json5",
    `{ plugins: ["./deploy/plugin.json5"], segments: { "plugins.deploy.status": { bg: "error" } }, root: { h: ["plugins.deploy.status"] } }`,
  );
  const prepared = await prepareConfig([p], dir, []);
  try {
    expect(prepared.config.segments["plugins.deploy.status"]).toMatchObject({ bg: "error" });
    expect(prepared.config.segments["plugins.deploy.status"]!.template).toContain("⇪");
  } finally {
    prepared.registry.dispose();
  }
});

test("a data file written after load, and replaced by rename, is read", async () => {
  const p = config();
  const prepared = await prepareConfig([p], dir, []);
  try {
    const read = () => (prepared.store.readDocument("plugins.deploy.data") as { value?: { state?: string } }).value?.state;
    // fs.watch attaches asynchronously with no ready signal: repeat the
    // (idempotent) write until the watcher delivers it.
    const until = async (state: string, write: () => void) => {
      for (let i = 0; i < 100 && read() !== state; i++) {
        write();
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(read()).toBe(state);
    };
    const data = path.join(dir, "deploy/state.json");
    await until("first", () => fs.writeFileSync(data, `{ "state": "first" }`));
    for (const state of ["second", "third"]) {
      await until(state, () => {
        fs.writeFileSync(`${data}.tmp`, `{ "state": "${state}" }`);
        fs.renameSync(`${data}.tmp`, data);
      });
    }
  } finally {
    prepared.registry.dispose();
  }
});

test("a plugin whose names another layer already declares is dropped; the first copy stays", async () => {
  const p = config();
  write("deploy/state.json", `{ "env": "prod", "state": "live" }`);
  fs.writeFileSync(p, `{ plugins: ["./deploy/plugin.json5", "./deploy/plugin.json5"], root: { h: ["plugins.deploy.status"] } }`);
  const prepared = await prepareConfig([p], dir, []);
  try {
    expect(prepared.droppedPlugins.map((d) => d.reason).join()).toContain(
      `plugin "deploy" is already listed`,
    );
    expect(prepared.config.segments["plugins.deploy.status"]).toBeDefined();
  } finally {
    prepared.registry.dispose();
  }
});

test("plugins must be a list of paths", async () => {
  const p = write("config.json5", `{ plugins: "./p.json5" }`);
  expect(fatal(await checkConfig(p, dir))).toContain(`"plugins" must be a list`);
});

// [LAW:nothing-unseen] The daemon's load carries which plugins merged and which
// dropped — the record the daemon logs on every load.
test("the daemon's load records the plugins it merged and dropped", () => {
  const good = config();
  write("q/plugin.json5", `{}`);
  fs.writeFileSync(
    good,
    `{ plugins: ["./deploy/plugin.json5", "./q/plugin.json5"], root: { h: ["plugins.deploy.status"] } }`,
  );
  const gitService = new GitDataProvider({ sanityIntervalMs: 0, logger: () => {} });
  try {
    const loaded = loadFromDisk(dir, dir, good, {
      gitService,
      sessionState: new SessionState(),
    });
    expect(loaded.state?.plugins.loaded).toEqual([path.join(dir, "deploy/plugin.json5")]);
    expect(loaded.state?.plugins.dropped.map((d) => d.path)).toEqual([
      path.join(dir, "q/plugin.json5"),
    ]);
    expect(loaded.warning ?? "").toContain("was not loaded");
    loaded.state?.registry.dispose();
  } finally {
    gitService.close();
  }
});

// brandon-plugins-ktag.5zv: a plugin an app installs by dropping a folder,
// with no config edit, under $XDG_DATA_HOME, an $XDG_DATA_DIRS entry, or a
// repo's own .cc-candybar/plugins.
describe("an installed plugin", () => {
  let saved: { home?: string; dirs?: string };
  beforeEach(() => {
    saved = { home: process.env.XDG_DATA_HOME, dirs: process.env.XDG_DATA_DIRS };
    process.env.XDG_DATA_HOME = path.join(dir, "data");
    process.env.XDG_DATA_DIRS = path.join(dir, "share");
  });
  afterEach(() => {
    process.env.XDG_DATA_HOME = saved.home;
    process.env.XDG_DATA_DIRS = saved.dirs;
  });

  const install = (root: string, name: string, definition: string): string =>
    write(`${root}/cc-candybar/plugins/${name}/plugin.json5`, definition);
  const repoInstall = (repo: string, name: string, definition: string): string =>
    write(`${repo}/.cc-candybar/plugins/${name}/plugin.json5`, definition);
  const placing = (seg: string) => write("config.json5", `{ root: { h: ["${seg}"] } }`);

  async function segmentsIn(projectDir: string): Promise<string[]> {
    const prepared = await prepareConfig([], projectDir, []);
    try {
      return Object.keys(prepared.config.segments).filter((n) => n.startsWith("plugins."));
    } finally {
      prepared.registry.dispose();
    }
  }

  test("renders once a config places it, named by its folder", async () => {
    install("data", "deploy", DEFINITION);
    write("data/cc-candybar/plugins/deploy/state.json", `{ "env": "prod", "state": "live" }`);
    const { rendered, warnings } = clean(await checkConfig(placing("plugins.deploy.status"), dir));
    expect(rendered).toContain("⇪ prod live");
    expect(warnings).toEqual([]);
  });

  test("an unplaced one is in the add-segment library and draws nothing", async () => {
    install("share", "deploy", DEFINITION);
    const prepared = await prepareConfig([], dir, []);
    try {
      const members = [...addableSegmentDomains(prepared.config).values()][0]!.members;
      expect(members).toContain("plugins.deploy.status");
    } finally {
      prepared.registry.dispose();
    }
  });

  test("a repo-shipped plugin is there only in sessions rooted in that repo", async () => {
    repoInstall("a", "deploy", DEFINITION);
    fs.mkdirSync(path.join(dir, "b"));
    expect(await segmentsIn(path.join(dir, "a"))).toEqual(["plugins.deploy.status"]);
    expect(await segmentsIn(path.join(dir, "b"))).toEqual([]);
  });

  test("one installed definition reads each repo's own project data", async () => {
    install(
      "data",
      "lit",
      `{ data: { project: ".lit/candybar.json" }, segments: { ticket: { template: '#{{ .plugins.lit.data.id }}' } } }`,
    );
    write("a/.lit/candybar.json", `{ "id": "a-1" }`);
    write("b/.lit/candybar.json", `{ "id": "b-2" }`);
    const p = placing("plugins.lit.ticket");
    expect(clean(await checkConfig(p, path.join(dir, "a"))).rendered).toContain("#a-1");
    expect(clean(await checkConfig(p, path.join(dir, "b"))).rendered).toContain("#b-2");
  });

  test("a nearer root replaces a farther one's plugin of the same name, whole", async () => {
    install("share", "deploy", `{ data: "./d.json", segments: { status: { template: "machine" }, extra: { template: "x" } } }`);
    install("data", "deploy", `{ data: "./d.json", segments: { status: { template: "user" } } }`);
    repoInstall("repo", "deploy", `{ data: "./d.json", segments: { status: { template: "repo" } } }`);
    expect(clean(await checkConfig(placing("plugins.deploy.status"), dir)).rendered).toContain("user");
    expect(await segmentsIn(dir)).toEqual(["plugins.deploy.status"]);
    expect(clean(await checkConfig(placing("plugins.deploy.status"), path.join(dir, "repo"))).rendered).toContain(
      "repo",
    );
  });

  test("a plugin the config lists replaces an installed one of its name", async () => {
    install("data", "deploy", `{ data: "./d.json", segments: { status: { template: "installed" } } }`);
    write("deploy/plugin.json5", `{ data: "./d.json", segments: { status: { template: "listed" } } }`);
    const p = write("config.json5", `{ plugins: ["./deploy/plugin.json5"], root: { h: ["plugins.deploy.status"] } }`);
    const { rendered } = clean(await checkConfig(p, dir));
    expect(rendered).toContain("listed");
    expect(rendered).not.toContain("installed");
  });

  test("a replacement that breaks a lower layer's reference into the name it replaces drops alone", async () => {
    install("data", "deploy", `{ data: "./d.json", actions: { go: { set: "k", to: "1" } }, segments: { status: { template: "installed" } } }`);
    const user = write("user.json5", `{ segments: { mine: { template: '{{ action "plugins.deploy.go" "go" }}' } } }`);
    write("repo/deploy/plugin.json5", `{ data: "./d.json", segments: { status: { template: "listed" } } }`);
    const project = write("repo/config.json5", `{ plugins: ["./deploy/plugin.json5"], root: { h: ["mine", "plugins.deploy.status"] } }`);
    const warnings: string[] = [];
    const prepared = await prepareConfig([user, project], dir, warnings);
    try {
      expect(warnings.join("\n")).toContain(`references unknown action "plugins.deploy.go"`);
    } finally {
      prepared.registry.dispose();
    }
  });

  test("a cycle the layer already held is not blamed on a plugin joining it", async () => {
    const user = write(
      "user.json5",
      `{ variables: { a: { kind: "template", template: "{{ .b }}" }, b: { kind: "template", template: "{{ .a }}" } } }`,
    );
    write("repo/deploy/plugin.json5", `{ data: "./d.json", segments: { status: { template: "x" } } }`);
    const project = write("repo/config.json5", `{ plugins: ["./deploy/plugin.json5"] }`);
    const warnings: string[] = [];
    await expect(prepareConfig([user, project], dir, warnings)).rejects.toThrow("Dependency cycle");
    expect(warnings.join("\n")).not.toContain("was not loaded");
  });

  test("a broken one leaves the config rendering; every reference into it is ⚠ naming the drop", async () => {
    install("data", "lit", `{ data: "./d.json", segments: { ticket: { template: "{{ if }}" } } }`);
    const p = write(
      "config.json5",
      `{
        segments: {
          mine: { template: "mine-here" },
          reads: { template: '{{ .plugins.lit.data.id }}' },
          binds: { template: '{{ action "plugins.lit.open" "go" }}' },
        },
        root: { h: ["mine", "reads", "binds", "plugins.lit.ticket"] },
      }`,
    );
    const message = fatal(await checkConfig(p, dir));
    const notice = `plugin ${path.join(dir, "data/cc-candybar/plugins/lit/plugin.json5")} was not loaded`;
    expect(message).toContain("1 plugin did not load");
    expect(message).toContain(`segment "reads"`);
    expect(message).toContain(`segment "binds"`);
    expect(message).not.toContain(`segment "mine"`);
    for (const line of message.split("\n").filter((l) => /segment "(reads|binds)"/.test(l))) {
      expect(line).toContain(notice);
    }
    const prepared = await prepareConfig([p], dir, []);
    try {
      expect(prepared.config.segments["plugins.lit.ticket"]!.template).toContain(notice);
    } finally {
      prepared.registry.dispose();
    }
  });

  test("a folder holding no definition is a drop naming its path, once a config reaches it", async () => {
    fs.mkdirSync(path.join(dir, "data/cc-candybar/plugins/empty"), { recursive: true });
    const notice = `plugin ${path.join(dir, "data/cc-candybar/plugins/empty/plugin.json5")} was not loaded`;
    const message = fatal(await checkConfig(placing("plugins.empty.s"), dir));
    expect(message).toContain("1 plugin did not load");
    expect(message).toContain(notice);
  });

  // Nobody asked for a plugin nothing places: a broken one a package manager
  // dropped is no config's problem.
  test("a broken one nothing reaches is no warning and passes check", async () => {
    install("share", "foo", `{ data: "./d.json", segments: { s: { template: "{{ if }}" } } }`);
    const warnings: string[] = [];
    const prepared = await prepareConfig([], dir, warnings);
    try {
      expect(prepared.droppedPlugins).toEqual([]);
      expect(warnings).toEqual([]);
    } finally {
      prepared.registry.dispose();
    }
    const p = write("config.json5", `{ segments: { mine: { template: "mine" } }, root: { h: ["mine"] } }`);
    expect(clean(await checkConfig(p, dir)).warnings).toEqual([]);
  });

  test("a call to a dropped plugin's helper is ⚠ naming the drop", async () => {
    install("data", "deploy", `{ data: "./d.json", segments: { s: { template: "{{ if }}" } }, helpers: { state: "x" } }`);
    const p = write(
      "config.json5",
      `{ segments: { calls: { template: '{{ template "plugins.deploy.state" .session }}' } }, root: { h: ["calls"] } }`,
    );
    const message = fatal(await checkConfig(p, dir));
    const line = message.split("\n").find((l) => l.includes(`segment "calls"`));
    expect(line).toContain(
      `plugin ${path.join(dir, "data/cc-candybar/plugins/deploy/plugin.json5")} was not loaded`,
    );
  });

  test("a dot-folder is never a plugin", async () => {
    fs.mkdirSync(path.join(dir, "repo/.cc-candybar/plugins/.git"), { recursive: true });
    const warnings: string[] = [];
    const prepared = await prepareConfig([], path.join(dir, "repo"), warnings);
    try {
      expect(prepared.droppedPlugins).toEqual([]);
      expect(warnings).toEqual([]);
    } finally {
      prepared.registry.dispose();
    }
  });

  test("a folder whose name is no plugin's stands in for the names nothing owns", async () => {
    install("data", "my-plugin", `{ data: "./d.json", segments: { s: { template: "x" } } }`);
    const message = fatal(await checkConfig(placing("plugins.myplugin.s"), dir));
    expect(message).toContain(`its folder "my-plugin" is not a plugin name`);
    expect(message).not.toContain("unknown segment");
  });

  test("the daemon's load reports only the definition that renders of a replaced name", () => {
    install("data", "deploy", `{ data: "./d.json", segments: { status: { template: "installed" } } }`);
    write("deploy/plugin.json5", `{ data: "./d.json", segments: { status: { template: "listed" } } }`);
    const p = write("config.json5", `{ plugins: ["./deploy/plugin.json5"], root: { h: ["plugins.deploy.status"] } }`);
    const gitService = new GitDataProvider({ sanityIntervalMs: 0, logger: () => {} });
    try {
      const loaded = loadFromDisk(dir, dir, p, { gitService, sessionState: new SessionState() });
      expect(loaded.state?.plugins.loaded).toEqual([path.join(dir, "deploy/plugin.json5")]);
      loaded.state?.registry.dispose();
    } finally {
      gitService.close();
    }
  });

  // A config that fails its first load still renders the seeded default; the
  // seed searches the entry's repo, so the plugin that would fix it reloads.
  test("a failed first load still watches the repo's plugin root", () => {
    const watchers = new WatcherRegistry({
      counters: { watchersOpened: 0, watchersClosed: 0, watchersEvicted: 0 },
      logger: () => {},
    });
    const gitService = new GitDataProvider({ sanityIntervalMs: 0, logger: () => {} });
    try {
      const repo = path.join(dir, "repo");
      fs.mkdirSync(repo);
      const p = write("config.json5", `{ root: { h: ["plugins.lit.status"] } }`);
      const cache = new RenderCache({ gitService, sessionState: new SessionState(), watchers });
      const entry = cache.getOrCreate(repo, repo, p);
      expect(entry.lastError).not.toBeNull();
      expect(entry.state.plugins.roots).toContain(path.join(repo, ".cc-candybar", "plugins"));
      entry.state.registry.dispose();
    } finally {
      watchers.closeAll();
      gitService.close();
    }
  });
  test("a `do` member naming a dropped plugin's action stands in", async () => {
    install("data", "lit", `{ data: "./d.json", segments: { s: { template: "{{ if }}" } }, actions: { open: { copy: "x" } } }`);
    const p = write(
      "config.json5",
      `{ actions: { mark: { set: "m", to: "1" }, both: { do: ["mark", "plugins.lit.open"] } }, variables: { m: { kind: "state", key: "m", default: "0" } }, segments: { b: { template: '{{ action "both" "go" }}' } }, root: { h: ["b"] } }`,
    );
    const prepared = await prepareConfig([p], dir, []);
    try {
      expect(prepared.config.actions["plugins.lit.open"]).toBeDefined();
      expect(prepared.droppedPlugins.map((d) => d.plugin)).toEqual(["lit"]);
    } finally {
      prepared.registry.dispose();
    }
  });

  test("a nearer layer's placement widens the stand-in's settings", async () => {
    install("data", "lit", `{ data: "./d.json", segments: { s: { template: "{{ if }}" } } }`);
    const user = write("user.json5", `{ root: { h: [{ seg: "plugins.lit.s", settings: { a: true } }] } }`);
    const project = write("project.json5", `{ root: { h: [{ seg: "plugins.lit.s", settings: { b: 3 } }] } }`);
    const prepared = await prepareConfig([user, project], dir, []);
    try {
      expect(Object.keys(prepared.config.segments["plugins.lit.s"]!.settings ?? {})).toContain("b");
    } finally {
      prepared.registry.dispose();
    }
  });

  test("a listed plugin that drops reports nothing rendering in place of the installed one it replaced", () => {
    install("data", "deploy", `{ data: "./d.json", segments: { status: { template: "installed" } } }`);
    write("deploy/plugin.json5", `{ data: "./d.json", segments: { status: { template: "{{ if }}" } } }`);
    const p = write("config.json5", `{ plugins: ["./deploy/plugin.json5"], root: { h: ["plugins.deploy.status"] } }`);
    const gitService = new GitDataProvider({ sanityIntervalMs: 0, logger: () => {} });
    try {
      const loaded = loadFromDisk(dir, dir, p, { gitService, sessionState: new SessionState() });
      expect(loaded.state?.plugins.loaded).toEqual([]);
      loaded.state?.registry.dispose();
    } finally {
      gitService.close();
    }
  });

  test("an unnamed drop listed by a lower layer stands in for an upper layer's placement", async () => {
    write("a.b/plugin.json5", `{ data: "./d.json", segments: {} }`);
    const user = write("user.json5", `{ plugins: ["./a.b/plugin.json5"] }`);
    const project = write("project.json5", `{ root: { h: ["plugins.zzz.s"] } }`);
    const prepared = await prepareConfig([user, project], dir, []);
    try {
      expect(prepared.config.segments["plugins.zzz.s"]!.template).toContain(`its folder \\"a.b\\" is not a plugin name`);
    } finally {
      prepared.registry.dispose();
    }
  });

  test.each(["../escape.json", "/abs/data.json", "~/data.json"])(
    "data.project %s is refused, naming the fix",
    async (rel) => {
      write("x/plugin.json5", `{ data: { project: "${rel}" }, segments: {} }`);
      const p = write("config.json5", `{ plugins: ["./x/plugin.json5"] }`);
      expect(fatal(await checkConfig(p, dir))).toContain("must be a path inside the project");
    },
  );

  test("a file directly in a root is a drop naming where it belongs; a dot-file is nothing", async () => {
    write("data/cc-candybar/plugins/deploy.json5", "{}");
    write("data/cc-candybar/plugins/.DS_Store", "");
    const message = fatal(await checkConfig(placing("plugins.deploy.s"), dir));
    expect(message).toContain(
      `move this file to ${path.join(dir, "data/cc-candybar/plugins/<name>/plugin.json5")}`,
    );
    expect(message).not.toContain(".DS_Store");
  });

  test("a drop is reached by its definition, not by its notice", () => {
    const def = install("data", "lit", `{ data: "./d.json", segments: { s: { template: "{{ if }}" } } }`);
    const p = placing("plugins.lit.s");
    const gitService = new GitDataProvider({ sanityIntervalMs: 0, logger: () => {} });
    try {
      const loaded = loadFromDisk(dir, dir, p, { gitService, sessionState: new SessionState() });
      expect([...(loaded.state?.plugins.reached ?? [])]).toEqual([def]);
      expect(loaded.state?.plugins.dropped.map((d) => d.path)).toEqual([def]);
      loaded.state?.registry.dispose();
    } finally {
      gitService.close();
    }
  });
});

describe("plugin roots", () => {
  let saved: { home?: string; dirs?: string };
  beforeEach(() => {
    saved = { home: process.env.XDG_DATA_HOME, dirs: process.env.XDG_DATA_DIRS };
  });
  afterEach(() => {
    process.env.XDG_DATA_HOME = saved.home;
    process.env.XDG_DATA_DIRS = saved.dirs;
  });

  test("the user's data home outranks package managers even when listed among them", () => {
    process.env.XDG_DATA_HOME = "/home/u/.local/share";
    process.env.XDG_DATA_DIRS = "/usr/share:/home/u/.local/share:/opt/share";
    expect(pluginRoots(null)).toEqual([
      "/opt/share/cc-candybar/plugins",
      "/usr/share/cc-candybar/plugins",
      "/home/u/.local/share/cc-candybar/plugins",
    ]);
  });
});

test("a listed definition that is not a folder's plugin.json5 is refused, naming the fix", async () => {
  write("plugins/deploy.json5", `{ data: "./d.json", segments: {} }`);
  const p = write(
    "config.json5",
    `{ plugins: ["./plugins/deploy.json5"], segments: { mine: { template: "mine" } }, root: { h: ["mine"] } }`,
  );
  const message = fatal(await checkConfig(p, dir));
  expect(message).toContain(`move this file to <dir>/<name>/plugin.json5`);
});

test("a placement under a refused loose definition's folder stands in naming the fix", async () => {
  write("deploy/state.json5", `{ data: "./d.json", segments: { s: { template: "x" } } }`);
  const p = write(
    "config.json5",
    `{ plugins: ["./deploy/state.json5"], root: { h: ["plugins.deploy.s"] } }`,
  );
  const message = fatal(await checkConfig(p, dir));
  expect(message).not.toContain("unknown segment");
  const prepared = await prepareConfig([p], dir, []);
  try {
    expect(prepared.config.segments["plugins.deploy.s"]!.template).toContain("move this file to");
  } finally {
    prepared.registry.dispose();
  }
});

test("a tombstone has no cache field", () => {
  expect(hasCacheField({ kind: "dropped", reason: "r", definition: "/d" })).toBe(false);
});
