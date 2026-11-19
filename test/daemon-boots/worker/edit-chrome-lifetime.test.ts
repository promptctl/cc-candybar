// [LAW:verifiable-goals] Edit mode's own controls live as long as the edit
// they serve, and a placement's state ends with the placement: a placement
// given the same id again opens with nothing from before. Driven as a user
// drives the bar, against a daemon in this worker, a restart included.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { linksOf, startBar, type Bar } from "../../helpers/drive-bar";
import { startBarDaemon } from "../../helpers/in-worker-daemon";
import { DOOR_GLYPH } from "../../../src/config/disclosure";
import { effectsOf } from "../../../src/click/read";
import { textOf, type Frame } from "../../../src/render/frame";
import { isChromeKey } from "../../../src/config/reserved-names";
import {
  configureMember,
  EDIT_CONFIGURE_KEY,
} from "../../../src/config/loader/edit-mode";
import { placementDraftKey } from "../../../src/config/edit-chrome";
import { encodeLayoutOp } from "../../../src/config/layout-ops";

jest.setTimeout(60_000);

// Placement `s` hosts a menu and has a setting; `ctl` removes and re-adds it
// with authored layout actions, out of edit mode.
const CONFIG = `{
  actions: {
    applyTheme: { set: "theme", from: "themes" },
    drop: { persist: "presets.default.root", removeSegment: "s" },
    add: { persist: "presets.default.root", insertSegment: "s", anchor: "directory", relation: "after" },
  },
  segments: {
    s: {
      template: '{{ menu "applyTheme" "S▸" "S▾" }}',
      settings: { show: { label: "show", domain: "bool", default: true } },
    },
    ctl: { template: '{{ action "drop" "DROP" }} {{ action "add" "ADD" }}' },
  },
  root: { h: ["directory", "s", "ctl"] },
}
`;

const configFile = (config: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-chrome-life-"));
  const file = path.join(dir, "config.json5");
  fs.writeFileSync(file, config);
  return file;
};

// The link of `frame` one of whose effects `match` accepts.
const linkWhere = (
  frame: Frame,
  match: (e: { verb: string; args: readonly string[] }) => boolean,
): string => {
  const hit = linksOf(frame).find((l) => effectsOf(l.url).some(match));
  if (hit === undefined) throw new Error("the bar drew no such link");
  return hit.url;
};
const writing = (frame: Frame, key: string, value: string): string =>
  linkWhere(frame, (e) => e.args[1] === key && e.args[2] === value);
const removing = (frame: Frame, id: string): string =>
  linkWhere(frame, (e) =>
    e.args.includes(encodeLayoutOp({ op: "remove", target: id })),
  );

describe("edit chrome and placement state live as long as what they serve", () => {
  let bar: Bar | undefined;
  afterEach(async () => bar?.stop());
  const start = async (config = CONFIG): Promise<Bar> => {
    bar = await startBar(
      {
        width: 240,
        rows: 60,
        config: configFile(config),
        cwd: process.cwd(),
        ssh: false,
      },
      startBarDaemon,
    );
    await bar.render();
    return bar;
  };
  const arrange = async (b: Bar): Promise<Frame> => {
    await b.click(DOOR_GLYPH);
    return (await b.click("✎ arrange")).rendered;
  };
  const configure = async (b: Bar, frame: Frame): Promise<Frame> =>
    (
      await b.follow(
        writing(frame, EDIT_CONFIGURE_KEY, configureMember("default", "s")),
      )
    ).rendered;
  const chromeIn = (stored: Readonly<Record<string, string>>): string[] =>
    Object.keys(stored).filter(isChromeKey);

  test("an authored remove and re-add out of edit mode brings the placement back closed", async () => {
    const b = await start();
    expect(textOf((await b.click("S▸")).rendered)).toContain("S▾");
    expect(textOf((await b.click("DROP")).rendered)).not.toContain("S▾");
    const back = textOf((await b.click("ADD")).rendered);
    expect(back).toContain("S▸");
    expect(back).not.toContain("S▾");
  });

  test("a layout reset ends the placement's menu, and the undo that brings the placement back leaves it closed", async () => {
    const b = await start();
    await b.click("S▸");
    await arrange(b);
    await b.click("↺ reset layout");
    expect(textOf((await b.click("✓ save")).rendered)).not.toContain("S▾");
    const { refused, rendered } = await b.click("↶");
    expect(refused).toBeNull();
    expect(textOf(rendered)).toContain("S▸");
    expect(textOf(rendered)).not.toContain("S▾");
  });

  test("a preset deleted and brought back opens its placement closed", async () => {
    const b = await start(`{
      actions: { applyTheme: { set: "theme", from: "themes" } },
      segments: { s: { template: '{{ menu "applyTheme" "S▸" "S▾" }}' } },
      globals: { preset: "p" },
      presets: { p: { root: { h: ["directory", "s"] } } },
      root: { h: ["directory"] },
    }`);
    expect(textOf((await b.click("S▸")).rendered)).toContain("S▾");
    await b.click(DOOR_GLYPH);
    await b.click("▦ preset");
    expect(textOf((await b.click("🚮 delete p")).rendered)).not.toContain("S▾");
    const { refused, rendered } = await b.click("↶");
    expect(refused).toBeNull();
    expect(textOf(rendered)).toContain("S▸");
    expect(textOf(rendered)).not.toContain("S▾");
  });

  test("an edit-mode removal undone restores the placement's drafts and none of its open controls", async () => {
    const b = await start();
    let frame = await configure(b, await arrange(b));
    frame = (
      await b.follow(
        writing(frame, placementDraftKey("default", "s", "show"), "false"),
      )
    ).rendered;
    expect(textOf(frame)).toContain("☐ show");
    // Back to arranging, with the draft held: what the bar looks like with
    // nothing of edit mode's open.
    frame = (await b.follow(writing(frame, EDIT_CONFIGURE_KEY, "closed")))
      .rendered;
    const arranging = textOf(frame);
    // The library in the gap after `s`, the third ✚ along the row.
    frame = (await b.click("✚", 3)).rendered;
    expect(textOf(frame)).not.toBe(arranging);
    frame = await configure(b, frame);
    frame = (await b.follow(removing(frame, "s"))).rendered;
    const { refused, rendered } = await b.click("↶");
    expect(refused).toBeNull();
    // As it was, but for the step there now is to redo.
    expect(textOf(rendered).replace(" ↷", "")).toBe(arranging);
    expect(textOf(await configure(b, rendered))).toContain("☐ show");
  });

  test("a restart mid-edit leaves no chrome stored and no edit open", async () => {
    const b = await start();
    const frame = await configure(b, await arrange(b));
    await b.follow(
      writing(frame, placementDraftKey("default", "s", "show"), "false"),
    );
    await b.click("✚");
    expect(chromeIn(await b.restart())).toEqual([]);
    const after = textOf(await b.render());
    expect(after).not.toContain("✚");
    expect(after).not.toContain("show");
  });

  test.each([
    ["✓ done", 1],
    ["✖", 1],
  ])("leaving edit mode by %s leaves no chrome stored", async (exit, nth) => {
    const b = await start();
    await configure(b, await arrange(b));
    await b.click("✚");
    const frame = await b.render();
    const exitText = linksOf(frame).some((l) => l.text === exit)
      ? exit
      : // `✓ save` while there is something to keep
        "✓ save";
    await b.click(exitText, nth);
    expect(textOf(await b.render())).not.toContain("✚");
    expect(chromeIn(await b.restart())).toEqual([]);
  });

  test("a chrome link clicked after its edit closed leaves nothing stored", async () => {
    const b = await start();
    const frame = await arrange(b);
    const stale = linksOf(frame).find((l) => l.text === "✚")!;
    await b.click("✖");
    const { rendered } = await b.followStale(stale);
    expect(textOf(rendered)).not.toContain("✚");
    expect(chromeIn(await b.restart())).toEqual([]);
  });

  test("a failed load that hides a placement releases nothing: it comes back as it was", async () => {
    const b = await start();
    expect(textOf((await b.click("S▸")).rendered)).toContain("S▾");
    // A restart loads the layers afresh: the broken file hides `s`, and the
    // mended one brings it back.
    fs.writeFileSync(b.configPath, "{ root: ");
    await b.restart();
    expect(textOf(await b.render())).not.toContain("S▾");
    fs.writeFileSync(b.configPath, CONFIG);
    await b.restart();
    expect(textOf(await b.render())).toContain("S▾");
  });

  test("a segment named edit, inserted twice from the library, loads and draws", async () => {
    const b = await start(`{
      segments: { edit: { template: "EDITSEG" } },
      root: { h: ["directory"] },
    }`);
    await arrange(b);
    const inserting = (frame: Frame) =>
      linksOf(frame).find((l) =>
        effectsOf(l.url).some((e) =>
          e.args.some((a) => a.startsWith("insert:edit:")),
        ),
      );
    for (let i = 0; i < 2; i++) {
      let { rendered } = await b.click("✚");
      // The library pages by category; `edit` is on one of them.
      for (let page = 0; inserting(rendered) === undefined && page < 10; page++)
        ({ rendered } = await b.click("→"));
      const { refused } = await b.follow(inserting(rendered)!.url);
      expect(refused).toBeNull();
    }
    const saved = await b.click("✓ save");
    expect(saved.refused).toBeNull();
    const text = textOf(await b.render());
    expect(text.split("EDITSEG")).toHaveLength(3);
    expect(text).not.toContain("⚠");
  });

  test("a shared key spelled like a placement id and that placement's own menu keep separate state", async () => {
    const b = await start(`{
      actions: {
        applyTheme: { set: "theme", from: "themes" },
        page: { set: "style", from: "styles" },
      },
      segments: {
        a: { template: '{{ menu "applyTheme" "A▸" "A▾" (dict "key" "s") }}' },
        s: { template: '{{ menu "page" "P▸" "P▾" }}' },
      },
      root: { h: ["a", "s"] },
    }`);
    let text = textOf((await b.click("A▸")).rendered);
    expect(text).toContain("A▾");
    expect(text).toContain("P▸");
    text = textOf((await b.click("P▸")).rendered);
    expect(text).toContain("A▾");
    expect(text).toContain("P▾");
  });
});
