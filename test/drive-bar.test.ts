// [LAW:verifiable-goals] scripts/drive-bar.ts is the tool a design doc's
// drawings are reproduced with, so it is held to what it promises: a click on
// what the bar drew lands in a daemon's session and the next render shows it, a
// durable one included; a durable click writes the harness's copy of the
// config, never the file it was started from; a click that would act on the
// developer's machine is not sent; a click on text the bar did not draw fails, naming what
// it did draw; a render fits the size it was asked for. These cases are about the bar, and draw on a daemon in this worker;
// what `pnpm bar` itself runs is in test/drive-bar.process.test.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cellLen } from "@promptctl/rich-js";

import { describeLink, linksOf, startBar, type Bar } from "./helpers/drive-bar";
import { DOOR_GLYPH } from "../src/config/disclosure";
import { textOf } from "../src/render/frame";
import { startBarDaemon } from "./helpers/in-worker-daemon";

jest.setTimeout(30_000);

const userConfig = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-drive-test-"));
  const file = path.join(dir, "config.json5");
  fs.writeFileSync(file, "{ root: { h: ['directory', 'model'] } }\n");
  return file;
};

describe("drive-bar", () => {
  let bar: Bar | undefined;
  afterEach(async () => bar?.stop());

  test("a durable click writes the copy, never the file it started from", async () => {
    const original = userConfig();
    const before = fs.readFileSync(original, "utf8");
    bar = await startBar(
      { width: 120, rows: 40, config: original, cwd: process.cwd(), ssh: false },
      startBarDaemon,
    );
    await bar.render();
    await bar.click(DOOR_GLYPH);
    await bar.click("⚙ config");
    // The second ▶ on screen: the first steps the preset control on the door's
    // line, the second the padding stepper in the config tab.
    const { rendered: out } = await bar.click("▶", 2);
    // The stepper's step is a session draft; save writes it to the config.
    const save = linksOf(out).find((l) => describeLink(l).startsWith("save "));
    expect(save).toBeDefined();
    await bar.click(save!.text);
    expect(fs.readFileSync(bar.configPath, "utf8")).toMatch(/padding/);
    expect(fs.readFileSync(original, "utf8")).toBe(before);
  });


  test("a click that rewrites the config file shows in the very next render", async () => {
    bar = await startBar(
      { width: 200, rows: 40, config: null, cwd: process.cwd(), ssh: false },
      startBarDaemon,
    );
    await bar.render();
    await bar.click(DOOR_GLYPH);
    await bar.click("✎ arrange");
    // ✖ #1 is the risen door; #2 removes host, #3 directory.
    expect(textOf((await bar.click("✖", 3)).rendered)).not.toContain("✖ directory");
    // Undo writes the file back; the render after it must already draw it.
    const { refused, rendered } = await bar.click("↶");
    expect(refused).toBeNull();
    expect(textOf(rendered)).toContain("✖ directory");
  });


  test("a render fits the size it was asked for", async () => {
    bar = await startBar(
      { width: 120, rows: 40, config: null, cwd: process.cwd(), ssh: false },
      startBarDaemon,
    );
    bar.resize({ width: 80, rows: 40 });
    const lines = textOf(await bar.render()).split("\n");
    expect(lines.filter((line) => cellLen(line) > 80)).toEqual([]);
  });

  test("a click on text the bar did not draw names what it drew", async () => {
    bar = await startBar(
      { width: 120, rows: 40, config: null, cwd: process.cwd(), ssh: false },
      startBarDaemon,
    );
    await bar.render();
    await expect(bar.click("no such button")).rejects.toThrow(
      new RegExp(`drew no link "no such button" #1; it drew: .*"${DOOR_GLYPH}"`),
    );
  });
});
