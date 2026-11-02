// [LAW:behavior-not-structure] A plugin's state variable, end to end through a bar
// on a daemon built in this worker: an action over it moves the state the segment
// reads back. The rest of the plugin cases, which boot no daemon, are
// test/plugins.test.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf } from "../../../src/render/frame";
import { startBar, type Bar } from "../../helpers/drive-bar";
import { startBarDaemon } from "../../helpers/in-worker-daemon";
import { until } from "../../helpers/until";

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

// A plugin segment may hold a `state` variable — what the session's own clicks
// wrote, never a source — so one of its actions can open and close a detail
// row of the segment's own. Driven through a daemon: the click's gate is derived
// from the plugin's cycle action like any config's.
describe("a plugin segment's state variable", () => {
  let bar: Bar | undefined;
  afterEach(async () => {
    await bar?.stop();
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
    bar = await startBar(
      { width: 120, rows: 40, config: p, cwd: dir, ssh: false },
      startBarDaemon,
    );
    // The data file is a watched source read after the load, so the first
    // render may still show the empty document.
    const started = bar;
    let closed = "";
    await until(
      async () => (closed = textOf(await started.render())).includes("n-1"),
      () => `the bar showing n-1; last:\n${closed}`,
    );
    expect(closed).toContain("n-1 ▸");
    expect(closed).not.toContain("the long form");
    const opened = await bar.click("▸");
    expect(opened.refused).toBeNull();
    // The detail is a second row of the segment's own, under its cell.
    expect(textOf(opened.rendered)).toMatch(/n-1 ▾[^\n]*\n[^\n]*the long form/);
    expect(textOf((await bar.click("▾")).rendered)).not.toContain("the long form");
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
    bar = await startBar(
      { width: 120, rows: 40, config: p, cwd: dir, ssh: false },
      startBarDaemon,
    );
    expect(textOf(await bar.render())).toContain("mine=user");
    const opened = await bar.click("▸");
    expect(opened.refused).toBeNull();
    const text = textOf(opened.rendered);
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
    bar = await startBar(
      { width: 120, rows: 40, config: p, cwd: dir, ssh: false },
      startBarDaemon,
    );
    expect(textOf(await bar.render())).toContain("n=3");
    const stepped = await bar.click("+");
    expect(stepped.refused).toBeNull();
    expect(textOf(stepped.rendered)).toContain("n=4");
  });
});
