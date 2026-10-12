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
      when: '{{ hasKey .deploy.data "env" }}',
      template: '⇪ {{ .deploy.data.env }} {{ template "deploy.state" .deploy.data }}',
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
    `{ plugins: ["./p/plugin.json5"], root: { h: ["deploy.status"] } }`,
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
    expect(message).toContain('segment "deploy.status"');
    expect(message).toContain("JSON parse failed");
  });

  test("its segments join the add-segment library", async () => {
    const warnings: string[] = [];
    const prepared = await prepareConfig(config(), dir, warnings);
    try {
      const members = [...addableSegmentDomains(prepared.config).values()][0]!.members;
      expect(members).toContain("deploy.status");
    } finally {
      prepared.registry.dispose();
    }
  });

  test("a data rewrite changes what the bar reads, without a reload", async () => {
    const p = config();
    const data = write("p/state.json", `{ "env": "prod", "state": "rolling" }`);
    const prepared = await prepareConfig(p, dir, []);
    try {
      const read = () => prepared.store.readDocument("deploy.data");
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
  const prepared = await prepareConfig(p, dir, warnings);
  try {
    expect(prepared.config.segments.mine).toBeDefined();
    expect(prepared.droppedPlugins).toHaveLength(1);
    expect(warnings.join("\n")).toContain("was not loaded");
  } finally {
    prepared.registry.dispose();
  }
});

test("a plugin whose names another layer already declares is dropped; the first copy stays", async () => {
  const p = config();
  write("p/state.json", `{ "env": "prod", "state": "live" }`);
  fs.writeFileSync(p, `{ plugins: ["./p/plugin.json5", "./p/plugin.json5"], root: { h: ["deploy.status"] } }`);
  const prepared = await prepareConfig(p, dir, []);
  try {
    expect(prepared.droppedPlugins.map((d) => d.reason).join()).toContain(
      `"deploy.data" is already declared`,
    );
    expect(prepared.config.segments["deploy.status"]).toBeDefined();
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
    `{ plugins: ["./p/plugin.json5", "./q/plugin.json5"], root: { h: ["deploy.status"] } }`,
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
