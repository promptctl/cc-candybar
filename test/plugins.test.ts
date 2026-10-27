// [LAW:behavior-not-structure] A plugin, end to end, as the two programs that
// meet it see it: `cc-candybar check` (the verdict an authoring agent reads)
// and the loaded config's live variable store (what the daemon renders from).
// brandon-plugins-ktag.8fv.

import { TEST_SIGNER } from "./helpers/link-signer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConfig, prepareConfig, type CheckOutcome } from "../src/check";
import { addableSegmentDomains } from "../src/config/edit-chrome";
import { stripAnsi } from "./helpers/daemon-e2e";
import { until } from "./helpers/until";
import { renderDsl } from "../src/dsl/render";
import { instantOf } from "../src/utils/instant";
import { memoryLimitBytes } from "../src/daemon/limits";
import {
  loadFromDisk,
  pluginLoadLine,
  RenderCache,
  renderCacheBudget,
  DECLARES_NOTHING,
  SOURCES_NOTHING,
} from "../src/daemon/cache/render";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { pluginRoots } from "../src/config/loader/plugin-folders";
import { hasCacheField } from "../src/config/dsl-types";
import { SessionState } from "../src/daemon/session-state";
import { startBar, type Bar } from "./helpers/drive-bar";
import { viewFacts } from "./helpers/view-facts";
import { NO_PLUGIN_STORAGE } from "./helpers/plugin-storage";
import { answerRepo } from "./helpers/repo-approval";
import { repoGateAt } from "../src/daemon/repo-configs";

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
    const prepared = await prepareConfig([config()], null, dir, warnings, instantOf(new Date()));
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
    const prepared = await prepareConfig([p], null, dir, [], instantOf(new Date()));
    try {
      const read = () => prepared.store.readDocument("plugins.deploy.data");
      expect(read()).toEqual({ kind: "ok", value: { env: "prod", state: "rolling" } });
      // fs.watch attaches asynchronously and has no ready signal, so the
      // (idempotent) rewrite repeats until the watcher delivers it.
      await until(() => {
        fs.writeFileSync(data, `{ "env": "prod", "state": "live" }`);
        return (read() as { value?: { state?: string } }).value?.state === "live";
      }, "the rewrite's arrival in the store");
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

  test("a variable named data, the data file's name", () =>
    dropped(
      `{ variables: { data: { kind: "literal", value: "x" } } }`,
      `"data" names the plugin's data file (.plugins.x.data)`,
    ));

  test("a variable the shared validator refuses", () =>
    dropped(
      `{ variables: { y: { kind: "shell", command: "true" } } }`,
      "variables.y",
    ));

  test("a variable template that does not parse", () =>
    dropped(
      `{ variables: { y: { kind: "template", template: "{{ if .z }}" } } }`,
      "Template parse error in variables.plugins.x.y.template",
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

  test("a segment var template that does not parse", () =>
    dropped(
      `{ segments: { s: { template: "x", vars: { p: { kind: "template", template: "{{ end }}" } } } } }`,
      "Template parse error in segments.plugins.x.s.vars.p.template",
    ));

  test("a template that does not parse", () =>
    dropped(
      `{ data: "./d.json", segments: { s: { template: "{{ if .x.data }}x" } } }`,
      "Template parse error in segments.plugins.x.s.template",
    ));

  test("a variable declared under another of its own, naming both", () =>
    dropped(
      `{ variables: { status: { kind: "literal", value: "x" }, "status.home": { kind: "literal", value: "y" } } }`,
      `variable "plugins.x.status.home" is declared under the variable "plugins.x.status"`,
    ));

  // A field read of a document lands on the document: each key re-runs the
  // other's source, so neither has a first value.
  test("two JSON shells whose cache keys read each other's fields", () =>
    dropped(
      `{ variables: {
        a: { kind: "shell", command: "echo {}", parse: { json: true }, cache: { key: "{{ .plugins.x.b.f }}" } },
        b: { kind: "shell", command: "echo {}", parse: { json: true }, cache: { key: "{{ .plugins.x.a.f }}" } },
      } }`,
      "Dependency cycle: plugins.x.a → plugins.x.b → plugins.x.a",
    ));

  test("a definition that is not there", () =>
    dropped(`{ data: "./d.json", segments: {} }`.replace(/.*/s, "{ "), "JSON5"));
});

test("the user's config still renders beside a dropped plugin", async () => {
  write("x/plugin.json5", `{ root: {} }`);
  const p = write(
    "config.json5",
    `{ plugins: ["./x/plugin.json5"], segments: { mine: { template: "mine-here" } }, root: { h: ["mine"] } }`,
  );
  const warnings: string[] = [];
  const prepared = await prepareConfig([p], null, dir, warnings, instantOf(new Date()));
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
    const prepared = await prepareConfig([p], null, dir, warnings, instantOf(new Date()));
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
    const prepared = await prepareConfig([p], null, dir, [], instantOf(new Date()));
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
    const prepared = await prepareConfig([p], null, dir, [], instantOf(new Date()));
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
  const prepared = await prepareConfig([p], null, dir, [], instantOf(new Date()));
  try {
    expect(prepared.config.segments["plugins.deploy.status"]).toMatchObject({ bg: "error" });
    expect(prepared.config.segments["plugins.deploy.status"]!.template).toContain("⇪");
  } finally {
    prepared.registry.dispose();
  }
});

test("a data file written after load, and replaced by rename, is read", async () => {
  const p = config();
  const prepared = await prepareConfig([p], null, dir, [], instantOf(new Date()));
  try {
    const read = () => (prepared.store.readDocument("plugins.deploy.data") as { value?: { state?: string } }).value?.state;
    // fs.watch attaches asynchronously with no ready signal: repeat the
    // (idempotent) write until the watcher delivers it.
    const delivered = (state: string, write: () => void) =>
      until(() => {
        write();
        return read() === state;
      }, `the store reading "${state}"`);
    const data = path.join(dir, "deploy/state.json");
    await delivered("first", () => fs.writeFileSync(data, `{ "state": "first" }`));
    for (const state of ["second", "third"]) {
      await delivered(state, () => {
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
  const prepared = await prepareConfig([p], null, dir, [], instantOf(new Date()));
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
  write("q/plugin.json5", `{ root: {} }`);
  fs.writeFileSync(
    good,
    `{ plugins: ["./deploy/plugin.json5", "./q/plugin.json5"], root: { h: ["plugins.deploy.status"] } }`,
  );
  const loaded = loadFromDisk(dir, dir, good, { storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER,
    sessionState: new SessionState(),
  });
  try {
    expect(loaded.state?.plugins.loaded).toEqual([path.join(dir, "deploy/plugin.json5")]);
    expect(loaded.state?.plugins.dropped.map((d) => d.path)).toEqual([
      path.join(dir, "q/plugin.json5"),
    ]);
    expect(loaded.warning ?? "").toContain("was not loaded");
  } finally {
    loaded.state?.registry.dispose();
  }
});

// Every key of a definition is optional, `data` included, and a definition may
// declare variables in a config's own vocabulary, named under the plugin.
describe("a plugin's own variables", () => {
  const HELLO = `{
    variables: {
      who: { kind: "literal", value: "world" },
      greeting: { kind: "template", template: "hello, {{ .plugins.hello.who }}" },
      open: { kind: "state", key: "open", default: "no" },
    },
    segments: {
      s: {
        template: "{{ .plugins.hello.greeting }} {{ .plugins.hello.s.n }} {{ .plugins.hello.s.out }} open={{ .plugins.hello.open }}",
        vars: {
          n: { kind: "literal", value: 7 },
          out: { kind: "shell", command: "printf ran", cache: { never: true } },
        },
      },
    },
  }`;
  const listing = (definition: string): string => {
    write("hello/plugin.json5", definition);
    return write(
      "config.json5",
      `{ plugins: ["./hello/plugin.json5"], root: { h: ["plugins.hello.s"] } }`,
    );
  };

  test("a definition without data loads, and declares no data variable", async () => {
    const p = listing(`{ segments: { s: { template: "no data here" } } }`);
    const { rendered, warnings } = clean(await checkConfig(p, dir));
    expect(rendered).toContain("no data here");
    expect(warnings).toEqual([]);
    const loaded = loadFromDisk(dir, dir, p, { storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER, sessionState: new SessionState() });
    try {
      expect(loaded.state?.plugins.loaded).toEqual([path.join(dir, "hello/plugin.json5")]);
      expect(Object.keys(loaded.state!.config.variables).filter((v) => v.startsWith("plugins.hello."))).toEqual([]);
      expect(pluginLoadLine(loaded.layers, loaded.state!, loaded.ms)).toContain(
        ` +${path.join(dir, "hello/plugin.json5")} data=none`,
      );
    } finally {
      loaded.state?.registry.dispose();
    }
  });

  test("an empty definition loads", async () => {
    write("hello/plugin.json5", `{}`);
    const p = write("config.json5", `{ plugins: ["./hello/plugin.json5"], root: { h: ["model"] } }`);
    expect(clean(await checkConfig(p, dir)).warnings).toEqual([]);
  });

  test("are named under the plugin, and its segment's vars of any kind load and draw", async () => {
    const p = listing(HELLO);
    const { rendered, warnings } = clean(await checkConfig(p, dir));
    expect(warnings).toEqual([]);
    expect(rendered).toContain("hello, world 7 ran open=no");
    const loaded = loadFromDisk(dir, dir, p, { storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER, sessionState: new SessionState() });
    try {
      const vars = loaded.state!.config.variables;
      expect(Object.keys(vars).filter((v) => v.startsWith("plugins.hello."))).toEqual([
        "plugins.hello.who",
        "plugins.hello.greeting",
        "plugins.hello.open",
      ]);
      expect(vars.who).toBeUndefined();
      expect(vars.greeting).toBeUndefined();
      // A state variable's session key lives under the plugin as its name does.
      expect(vars["plugins.hello.open"]).toMatchObject({ kind: "state", key: "plugins.hello.open" });
    } finally {
      loaded.state?.registry.dispose();
    }
  });

  test("a template reading one by its bare name is a drop", async () => {
    const p = listing(`{
      variables: { who: { kind: "literal", value: "world" } },
      segments: { s: { template: "{{ .who }}" } },
    }`);
    const message = fatal(await checkConfig(p, dir));
    expect(message).toContain(`plugin ${path.join(dir, "hello/plugin.json5")} was not loaded`);
    expect(message).toContain("who");
  });

  // [LAW:nothing-unseen] The config-load event counts the variables the loaded
  // plugins declared: the data file is not one, a dropped plugin's are not.
  test("the daemon's load line counts them", () => {
    const p = listing(HELLO);
    write("d/plugin.json5", `{ data: "./d.json", variables: { a: { kind: "literal", value: 1 } } }`);
    write("q/plugin.json5", `{ root: {}, variables: { b: { kind: "literal", value: 1 } } }`);
    fs.writeFileSync(
      p,
      `{ plugins: ["./hello/plugin.json5", "./d/plugin.json5", "./q/plugin.json5"], root: { h: ["plugins.hello.s"] } }`,
    );
    const loaded = loadFromDisk(dir, dir, p, { storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER, sessionState: new SessionState() });
    try {
      expect(pluginLoadLine(loaded.layers, loaded.state!, loaded.ms)).toContain(
        " plugins loaded=2 sources=0 pluginVariables=4 dropped=1 ",
      );
    } finally {
      loaded.state?.registry.dispose();
    }
  });

  test("none declared counts zero", () => {
    const loaded = loadFromDisk(dir, dir, config(), { storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER, sessionState: new SessionState() });
    try {
      expect(pluginLoadLine(loaded.layers, loaded.state!, loaded.ms)).toContain(" pluginVariables=0 ");
    } finally {
      loaded.state?.registry.dispose();
    }
  });
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
  // A repository's own plugin, in a repository the user approved.
  const repoInstall = (repo: string, name: string, definition: string): string => {
    const file = write(`${repo}/.cc-candybar/plugins/${name}/plugin.json5`, definition);
    answerRepo(path.join(dir, repo));
    return file;
  };
  const placing = (seg: string) => write("config.json5", `{ root: { h: ["${seg}"] } }`);

  async function segmentsIn(projectDir: string): Promise<string[]> {
    const prepared = await prepareConfig(
      [],
      repoGateAt(projectDir).plugins,
      projectDir,
      [],
      instantOf(new Date()),
    );
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
    const prepared = await prepareConfig([], null, dir, [], instantOf(new Date()));
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

  const CHECKOUT_DEFINITION = `{ data: { checkout: ".lit/state.json" }, segments: { ticket: { template: '#{{ .plugins.lit.data.id }}' } } }`;

  test("one installed definition reads each checkout's own data, from its root", async () => {
    install("data", "lit", CHECKOUT_DEFINITION);
    fs.mkdirSync(path.join(dir, "a/.git"), { recursive: true });
    fs.mkdirSync(path.join(dir, "b/.git"), { recursive: true });
    write("a/.lit/state.json", `{ "id": "a-1" }`);
    write("b/.lit/state.json", `{ "id": "b-2" }`);
    fs.mkdirSync(path.join(dir, "a/deep/sub"), { recursive: true });
    const p = placing("plugins.lit.ticket");
    expect(clean(await checkConfig(p, path.join(dir, "a/deep/sub"))).rendered).toContain("#a-1");
    expect(clean(await checkConfig(p, path.join(dir, "b"))).rendered).toContain("#b-2");
  });

  // A worktree session's project is the main checkout it was opened from; its
  // working directory is the worktree, whose `.git` is a file. The data is the
  // worktree's own.
  test("a worktree session reads the worktree's data, not its project's", () => {
    install("data", "lit", CHECKOUT_DEFINITION);
    fs.mkdirSync(path.join(dir, "main/.git"), { recursive: true });
    write("main/.claude/worktrees/w/.git", "gitdir: ../../../.git/worktrees/w\n");
    const loaded = loadFromDisk(
      path.join(dir, "main"),
      path.join(dir, "main/.claude/worktrees/w"),
      placing("plugins.lit.ticket"),
      { storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER, sessionState: new SessionState() },
    );
    try {
      expect(loaded.error).toBeNull();
      const data = path.join(dir, "main/.claude/worktrees/w/.lit/state.json");
      expect(loaded.state?.config.variables["plugins.lit.data"]).toMatchObject({ path: data });
      // [LAW:nothing-unseen] The daemon's load line names the file it read,
      // and the checkout it resolved against.
      const line = pluginLoadLine(loaded.layers, loaded.state!, loaded.ms);
      expect(line).toMatch(/ checkout=git:\S+ ms=\d+ /);
      expect(line).toContain(
        ` +${path.join(dir, "data/cc-candybar/plugins/lit/plugin.json5")} data=${data}`,
      );
      expect(line).toContain(` checkout=git:${path.join(dir, "main/.claude/worktrees/w")} `);
    } finally {
      loaded.state?.registry.dispose();
    }
  });

  // brandon-unfiled-3248.8yp: the data path a `{ checkout }` plugin resolves
  // differs per checkout, so every worktree's config differs — but only in that
  // variable, which a compile never reads. Every worktree of a repo shares one
  // compile, and each still renders its own checkout's data.
  test("worktrees share one compile, and each renders its own checkout's data", async () => {
    install("data", "lit", CHECKOUT_DEFINITION);
    fs.mkdirSync(path.join(dir, "main/.git"), { recursive: true });
    write("main/.claude/worktrees/w/.git", "gitdir: ../../../.git/worktrees/w\n");
    write("main/.lit/state.json", `{ "id": "main-1" }`);
    write("main/.claude/worktrees/w/.lit/state.json", `{ "id": "w-2" }`);
    fs.mkdirSync(path.join(dir, "main/src"), { recursive: true });
    const p = placing("plugins.lit.ticket");
    const watchers = new WatcherRegistry({
      counters: { watchersOpened: 0, watchersClosed: 0, watchRefusals: 0, watchErrors: 0 },
      logger: () => {},
    });
    const cache = new RenderCache(
      { storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER,
        sessionState: new SessionState(),
        watchers,
        source: SOURCES_NOTHING,
        declare: DECLARES_NOTHING,
      },
      { budgetBytes: () => renderCacheBudget(memoryLimitBytes({})) },
    );
    try {
      const main = path.join(dir, "main");
      const cwds = [main, path.join(main, ".claude/worktrees/w"), path.join(main, "src")];
      const states = cwds.map((cwd) => cache.getOrCreate(main, cwd, p).state);
      expect(states.map((s) => s.config.variables["plugins.lit.data"])).toMatchObject([
        { path: path.join(main, ".lit/state.json") },
        { path: path.join(main, ".claude/worktrees/w/.lit/state.json") },
        { path: path.join(main, ".lit/state.json") },
      ]);
      expect(cache.stats).toMatchObject({ size: 3, compiles: 1 });
      const drawn = await Promise.all(
        cwds.map(async (cwd, i) => {
          // Each through a session's view of its entry, as the daemon draws.
          using held = cache.holdSession(main, cwd, p, viewFacts(cwd, `s${i}`));
          const s = held.state;
          expect(s).toBe(states[i]);
          expect(await s.registry.settled(5000)).toEqual([]);
          return stripAnsi(
            renderDsl(
              s.config,
              s.compiled,
              held.view.store,
              held.view.registry,
              { session_id: `s${i}`, project_dir: main },
              instantOf(new Date()),
              { endcaps: "powerline", colorCompatibility: "truecolor", wrap: true, padding: 1, width: 200 },
            ),
          );
        }),
      );
      expect(drawn[0]).toContain("#main-1");
      expect(drawn[1]).toContain("#w-2");
      expect(drawn[2]).toContain("#main-1");
    } finally {
      cache.close();
      watchers.closeAll();
    }
  });

  test("a working directory in no checkout is its own root", async () => {
    install("data", "lit", CHECKOUT_DEFINITION);
    write("loose/.lit/state.json", `{ "id": "l-3" }`);
    const p = placing("plugins.lit.ticket");
    expect(clean(await checkConfig(p, path.join(dir, "loose"))).rendered).toContain("#l-3");
  });

  // The installed layer is memoised; a `.git` appearing above a directory
  // moves the checkout its data resolves against, and the next load sees it.
  test("a checkout created above a directory moves its data on the next load", () => {
    install("data", "lit", CHECKOUT_DEFINITION);
    fs.mkdirSync(path.join(dir, "outer/inner"), { recursive: true });
    const p = placing("plugins.lit.ticket");
    const load = (): string => {
      const loaded = loadFromDisk(dir, path.join(dir, "outer/inner"), p, { storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER,
        sessionState: new SessionState(),
      });
      loaded.state?.registry.dispose();
      return pluginLoadLine(loaded.layers, loaded.state!, loaded.ms);
    };
    const before = load();
    expect(before).toContain(` checkout=dir:${path.join(dir, "outer/inner")} `);
    expect(before).toContain(` data=${path.join(dir, "outer/inner/.lit/state.json")}`);
    fs.mkdirSync(path.join(dir, "outer/.git"));
    const after = load();
    expect(after).toContain(` checkout=git:${path.join(dir, "outer")} `);
    expect(after).toContain(` data=${path.join(dir, "outer/.lit/state.json")}`);
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
    const prepared = await prepareConfig([user, project], null, dir, warnings, instantOf(new Date()));
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
    await expect(prepareConfig([user, project], null, dir, warnings, instantOf(new Date()))).rejects.toThrow("Dependency cycle");
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
    const prepared = await prepareConfig([p], null, dir, [], instantOf(new Date()));
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
    const prepared = await prepareConfig([], null, dir, warnings, instantOf(new Date()));
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
    const prepared = await prepareConfig([], null, path.join(dir, "repo"), warnings, instantOf(new Date()));
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
    const loaded = loadFromDisk(dir, dir, p, { storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER, sessionState: new SessionState() });
    try {
      expect(loaded.state?.plugins.loaded).toEqual([path.join(dir, "deploy/plugin.json5")]);
    } finally {
      loaded.state?.registry.dispose();
    }
  });

  // A config that fails its first load still renders the seeded default; the
  // seed searches the entry's repo, so the plugin that would fix it reloads.
  test("a failed first load still watches the repo's plugin root", () => {
    const watchers = new WatcherRegistry({
      counters: { watchersOpened: 0, watchersClosed: 0, watchRefusals: 0, watchErrors: 0 },
      logger: () => {},
    });
    const cache = new RenderCache(
      { storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER,
        sessionState: new SessionState(),
        watchers,
        source: SOURCES_NOTHING,
        declare: DECLARES_NOTHING,
      },
      { budgetBytes: () => renderCacheBudget(memoryLimitBytes({})) },
    );
    try {
      const repo = path.join(dir, "repo");
      fs.mkdirSync(repo);
      answerRepo(repo);
      const p = write("config.json5", `{ root: { h: ["plugins.lit.status"] } }`);
      const entry = cache.getOrCreate(repo, repo, p);
      expect(entry.lastError).not.toBeNull();
      expect(entry.state.plugins.roots).toContain(path.join(repo, ".cc-candybar", "plugins"));
    } finally {
      cache.close();
      watchers.closeAll();
    }
  });
  test("a `do` member naming a dropped plugin's action stands in", async () => {
    install("data", "lit", `{ data: "./d.json", segments: { s: { template: "{{ if }}" } }, actions: { open: { copy: "x" } } }`);
    const p = write(
      "config.json5",
      `{ actions: { mark: { set: "m", to: "1" }, both: { do: ["mark", "plugins.lit.open"] } }, variables: { m: { kind: "state", key: "m", default: "0" } }, segments: { b: { template: '{{ action "both" "go" }}' } }, root: { h: ["b"] } }`,
    );
    const prepared = await prepareConfig([p], null, dir, [], instantOf(new Date()));
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
    const prepared = await prepareConfig([user, project], null, dir, [], instantOf(new Date()));
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
    const loaded = loadFromDisk(dir, dir, p, { storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER, sessionState: new SessionState() });
    try {
      expect(loaded.state?.plugins.loaded).toEqual([]);
    } finally {
      loaded.state?.registry.dispose();
    }
  });

  test("an unnamed drop listed by a lower layer stands in for an upper layer's placement", async () => {
    write("a.b/plugin.json5", `{ data: "./d.json", segments: {} }`);
    const user = write("user.json5", `{ plugins: ["./a.b/plugin.json5"] }`);
    const project = write("project.json5", `{ root: { h: ["plugins.zzz.s"] } }`);
    const prepared = await prepareConfig([user, project], null, dir, [], instantOf(new Date()));
    try {
      expect(prepared.config.segments["plugins.zzz.s"]!.template).toContain(`its folder \\"a.b\\" is not a plugin name`);
    } finally {
      prepared.registry.dispose();
    }
  });

  test.each(["../escape.json", "/abs/data.json", "~/data.json"])(
    "data.checkout %s is refused, naming the fix",
    async (rel) => {
      write("x/plugin.json5", `{ data: { checkout: "${rel}" }, segments: {} }`);
      const p = write("config.json5", `{ plugins: ["./x/plugin.json5"] }`);
      expect(fatal(await checkConfig(p, dir))).toContain("must be a path inside the checkout");
    },
  );

  test("data: { project }, the field's spelling before { checkout }, is refused pointing at checkout", async () => {
    write("x/plugin.json5", `{ data: { project: ".lit/candybar.json" }, segments: {} }`);
    const p = write("config.json5", `{ plugins: ["./x/plugin.json5"] }`);
    expect(fatal(await checkConfig(p, dir))).toContain("data: { project } is now data: { checkout }");
  });

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
    const loaded = loadFromDisk(dir, dir, p, { storage: NO_PLUGIN_STORAGE, signer: TEST_SIGNER, sessionState: new SessionState() });
    try {
      expect([...(loaded.state?.plugins.reached ?? [])]).toEqual([def]);
      expect(loaded.state?.plugins.dropped.map((d) => d.path)).toEqual([def]);
    } finally {
      loaded.state?.registry.dispose();
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
  const prepared = await prepareConfig([p], null, dir, [], instantOf(new Date()));
  try {
    expect(prepared.config.segments["plugins.deploy.s"]!.template).toContain("move this file to");
  } finally {
    prepared.registry.dispose();
  }
});

test("a tombstone has no cache field", () => {
  expect(hasCacheField({ kind: "dropped", reason: "r", definition: "/d" })).toBe(false);
});

// A plugin segment may hold a `state` variable — what the session's own clicks
// wrote, never a source — so one of its actions can open and close a detail
// row of the segment's own. Driven through a real daemon: the click's gate is
// derived from the plugin's cycle action like any config's.
describe("a plugin segment's state variable", () => {
  let bar: Bar | undefined;
  afterEach(() => {
    bar?.stop();
    bar = undefined;
  });

  test("a cycle action over it opens and closes the segment's own detail row", async () => {
    write(
      "x/plugin.json5",
      `{
        data: "./state.json",
        segments: {
          s: {
            template: '{{ .plugins.x.data.n }} {{ action "plugins.x.more" "▸" "▾" }}{{ if eq .plugins.x.s.detail "open" }}\\n{{ .plugins.x.data.long }}{{ end }}',
            vars: { detail: { kind: "state", key: "x-detail", default: "closed" } },
          },
        },
        actions: { more: { set: "x-detail", cycle: ["closed", "open"] } },
      }`,
    );
    write("x/state.json", `{ "n": "n-1", "long": "the long form" }`);
    const p = write(
      "config.json5",
      `{ plugins: [${JSON.stringify(path.join(dir, "x/plugin.json5"))}], root: { h: ["plugins.x.s"] } }`,
    );
    bar = await startBar({ width: 120, rows: 40, config: p, cwd: dir, ssh: false });
    // The data file is a watched source read after the load, so the first
    // render may still show the empty document.
    let closed = stripAnsi(await bar.render());
    for (let i = 0; i < 50 && !closed.includes("n-1"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      closed = stripAnsi(await bar.render());
    }
    expect(closed).toContain("n-1 ▸");
    expect(closed).not.toContain("the long form");
    const opened = await bar.click("▸");
    expect(opened.refused).toBeNull();
    // The detail is a second row of the segment's own, under its cell.
    expect(stripAnsi(opened.rendered)).toMatch(/n-1 ▾[^\n]*\n[^\n]*the long form/);
    expect(stripAnsi((await bar.click("▾")).rendered)).not.toContain("the long form");
  });

  // The bare `key` the plugin writes on both sides meets under `plugins.x.`,
  // so the user's file may hold the same bare key, under another kind, and
  // neither clashes with nor hears the other: a kind clash on one key fails a
  // whole load, which would take the user's bar away for a plugin's choice of
  // word.
  test("its key lives under the plugin's namespace, apart from the same bare key in the user's file", async () => {
    write(
      "x/plugin.json5",
      `{
        data: "./state.json",
        segments: {
          s: {
            template: '{{ action "plugins.x.more" "▸" "▾" }}{{ if eq .plugins.x.s.detail "open" }} detail{{ end }}',
            vars: { detail: { kind: "state", key: "x-detail", default: "closed" } },
          },
        },
        actions: { more: { set: "x-detail", cycle: ["closed", "open"] } },
      }`,
    );
    write("x/state.json", `{}`);
    const p = write(
      "config.json5",
      `{
        plugins: [${JSON.stringify(path.join(dir, "x/plugin.json5"))}],
        variables: { mine: { kind: "state", key: "x-detail", default: "user" } },
        actions: { page: { set: "x-detail", int: true } },
        segments: { u: { template: "mine={{ .mine }}" } },
        root: { h: ["u", "plugins.x.s"] },
      }`,
    );
    bar = await startBar({ width: 120, rows: 40, config: p, cwd: dir, ssh: false });
    expect(stripAnsi(await bar.render())).toContain("mine=user");
    const opened = await bar.click("▸");
    expect(opened.refused).toBeNull();
    const text = stripAnsi(opened.rendered);
    expect(text).toContain("▾ detail");
    expect(text).toContain("mine=user");
  });

  // A stepped key starts from its `state` variable's `default`, a segment
  // local's included: the first click on a stepper over a plugin's var steps
  // from what the cell shows, not from the range's floor.
  test("a stepper over it steps from the default the cell shows", async () => {
    write(
      "x/plugin.json5",
      `{
        data: "./state.json",
        segments: {
          s: {
            template: 'n={{ .plugins.x.s.n }} {{ action "plugins.x.up" "+" }}',
            vars: { n: { kind: "state", key: "n", default: "3" } },
          },
        },
        actions: { up: { set: "n", min: 0, max: 5, by: 1 } },
      }`,
    );
    write("x/state.json", `{}`);
    const p = write(
      "config.json5",
      `{ plugins: [${JSON.stringify(path.join(dir, "x/plugin.json5"))}], root: { h: ["plugins.x.s"] } }`,
    );
    bar = await startBar({ width: 120, rows: 40, config: p, cwd: dir, ssh: false });
    expect(stripAnsi(await bar.render())).toContain("n=3");
    const stepped = await bar.click("+");
    expect(stepped.refused).toBeNull();
    expect(stripAnsi(stepped.rendered)).toContain("n=4");
  });
});
