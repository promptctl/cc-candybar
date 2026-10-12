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
import { loadFromDisk } from "../src/daemon/cache/render";
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
  plugin: "deploy",
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
// resolves against the listing file and the data path against the definition.
function config(definition = DEFINITION): string {
  write("p/plugin.json5", definition);
  return write(
    "config.json5",
    `{ plugins: ["./p/plugin.json5"], root: { h: ["plugins.deploy.status"] } }`,
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
    write("p/state.json", `{ "env": "prod", "state": "live" }`);
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
    write("p/state.json", `{ "env": `);
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
    const data = write("p/state.json", `{ "env": "prod", "state": "rolling" }`);
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
  async function dropped(definition: string, expected: string): Promise<void> {
    write("p/plugin.json5", definition);
    const p = write(
      "config.json5",
      `{ plugins: ["./p/plugin.json5"], segments: { mine: { template: "mine" } }, root: { h: ["mine"] } }`,
    );
    const message = fatal(await checkConfig(p, dir));
    expect(message).toContain(`plugin ${path.join(dir, "p/plugin.json5")} was not loaded`);
    expect(message).toContain(expected);
  }

  test("a definition declaring a source of its own", () =>
    dropped(
      `{ plugin: "x", data: "./d.json", segments: {}, variables: { y: { kind: "shell", command: "true", cache: { never: true } } } }`,
      `a plugin definition may not declare "variables"`,
    ));

  test("a definition editing root", () =>
    dropped(`{ plugin: "x", data: "./d.json", segments: {}, root: { h: [] } }`, `may not declare "root"`));

  test("a plugin name that is not one identifier", () =>
    dropped(`{ plugin: "a.b", data: "./d.json", segments: {} }`, `"plugin" must be a name`));


  test("a template naming something nothing declares", () =>
    dropped(`{ plugin: "x", data: "./d.json", segments: { s: { template: "{{ .nope.y }}" } } }`, "nope"));

  test("a segment declaring vars of its own (a source)", () =>
    dropped(
      `{ plugin: "x", data: "./d.json", segments: { s: { template: "x", vars: { p: { kind: "shell", command: "true", cache: { never: true } } } } } }`,
      `may not declare "vars"`,
    ));

  test("a template that does not parse", () =>
    dropped(
      `{ plugin: "x", data: "./d.json", segments: { s: { template: "{{ if .x.data }}x" } } }`,
      "Template parse error in segments.plugins.x.s.template",
    ));

  test("a definition that is not there", () =>
    dropped(`{ plugin: "x", data: "./d.json", segments: {} }`.replace(/.*/s, "{ "), "JSON5"));
});

test("the user's config still renders beside a dropped plugin", async () => {
  write("p/plugin.json5", `{ plugin: "x" }`);
  const p = write(
    "config.json5",
    `{ plugins: ["./p/plugin.json5"], segments: { mine: { template: "mine-here" } }, root: { h: ["mine"] } }`,
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
  write("p/plugin.json5", `{ plugin: "candybar", data: "./d.json", segments: { s: { template: "mine" } } }`);
  const p = write("config.json5", `{ plugins: ["./p/plugin.json5"], root: { h: ["plugins.candybar.s"] } }`);
  expect(clean(await checkConfig(p, dir)).rendered).toContain("mine");
});

describe("a placed segment of a dropped plugin stands in as a cell, not a broken config", () => {
  async function placed(definition: string | null): Promise<string> {
    if (definition !== null) write("p/plugin.json5", definition);
    const p = write(
      "config.json5",
      `{ plugins: ["./p/plugin.json5"], segments: { mine: { template: "mine-here" } }, root: { h: ["mine", "plugins.deploy.status"] } }`,
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

  test("when the definition named itself", async () => {
    expect(await placed(`{ plugin: "deploy", data: "./d.json", segments: { status: { template: "{{ if }}" } } }`)).toContain(
      "plugins.deploy.status: plugin not loaded",
    );
  });

  test("when the definition could not be read at all", async () => {
    expect(await placed(null)).toContain("plugins.deploy.status: plugin not loaded");
  });

  test("and check still fails, naming the drop", async () => {
    const p = write(
      "config.json5",
      `{ plugins: ["./p/plugin.json5"], root: { h: ["plugins.deploy.status"] } }`,
    );
    const message = fatal(await checkConfig(p, dir));
    expect(message).toContain("1 listed plugin did not load");
    expect(message).not.toContain("render error");
  });

  test("a by-field retune and placement settings still load", async () => {
    const p = write(
      "config.json5",
      `{ plugins: ["./p/plugin.json5"],
         segments: { "plugins.deploy.status": { palette: "nord" } },
         root: { h: [{ seg: "plugins.deploy.status", settings: { compact: true } }, { seg: "plugins.deploy.status", id: "two", settings: { compact: false } }] } }`,
    );
    const prepared = await prepareConfig([p], dir, []);
    try {
      expect(prepared.config.segments["plugins.deploy.status"]!.template).toContain("plugin not loaded");
    } finally {
      prepared.registry.dispose();
    }
  });

  test("the user's own dotted names and groups are never blamed on a drop", async () => {
    const p = write(
      "config.json5",
      `{ plugins: ["./p/plugin.json5"],
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
    write("p/plugin.json5", DEFINITION);
    const p = write("config.json5", `{ plugins: ["./p/plugin.json5"], root: { h: ["plugins.deploy.statsu"] } }`);
    expect(fatal(await checkConfig(p, dir))).toContain(`"plugins.deploy.statsu" does not match any declared segment`);
  });
});

test("the user's file retunes a plugin segment by field", async () => {
  write("p/plugin.json5", DEFINITION);
  write("p/state.json", `{ "env": "prod", "state": "live" }`);
  const p = write(
    "config.json5",
    `{ plugins: ["./p/plugin.json5"], segments: { "plugins.deploy.status": { bg: "error" } }, root: { h: ["plugins.deploy.status"] } }`,
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
    const data = path.join(dir, "p/state.json");
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
  write("p/state.json", `{ "env": "prod", "state": "live" }`);
  fs.writeFileSync(p, `{ plugins: ["./p/plugin.json5", "./p/plugin.json5"], root: { h: ["plugins.deploy.status"] } }`);
  const prepared = await prepareConfig([p], dir, []);
  try {
    expect(prepared.droppedPlugins.map((d) => d.reason).join()).toContain(
      `"plugins.deploy.data" is already declared`,
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
  write("q/plugin.json5", `{ plugin: "x" }`);
  fs.writeFileSync(
    good,
    `{ plugins: ["./p/plugin.json5", "./q/plugin.json5"], root: { h: ["plugins.deploy.status"] } }`,
  );
  const gitService = new GitDataProvider({ sanityIntervalMs: 0, logger: () => {} });
  try {
    const loaded = loadFromDisk(dir, dir, good, {
      gitService,
      sessionState: new SessionState(),
    });
    expect(loaded.state?.plugins.loaded).toEqual([path.join(dir, "p/plugin.json5")]);
    expect(loaded.state?.plugins.dropped.map((d) => d.path)).toEqual([
      path.join(dir, "q/plugin.json5"),
    ]);
    expect(loaded.warning ?? "").toContain("was not loaded");
    loaded.state?.registry.dispose();
  } finally {
    gitService.close();
  }
});
