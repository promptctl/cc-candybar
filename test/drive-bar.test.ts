// [LAW:verifiable-goals] scripts/drive-bar.ts is the tool a design doc's
// drawings are reproduced with, so it is held to what it promises: a click on
// what the bar drew lands in a real daemon's session and the next render shows
// it, a durable one included; a durable click writes the harness's copy of the
// config, never the file it was started from; a click that would act on the
// developer's machine is not sent; a click on text the bar did not draw fails, naming what
// it did draw.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describeLink, drawnLinks, startBar, type Bar } from "./helpers/drive-bar";
import { DOOR_CLOSE_GLYPH, DOOR_GLYPH } from "../src/config/disclosure";
import { stripAnsi } from "./helpers/ansi";

jest.setTimeout(30_000);

const userConfig = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-drive-test-"));
  const file = path.join(dir, "config.json5");
  fs.writeFileSync(file, "{ root: { h: ['directory', 'model'] } }\n");
  return file;
};

describe("drive-bar", () => {
  let bar: Bar | undefined;
  afterEach(() => bar?.stop());

  test("a click on the door opens the menu in the next render", async () => {
    bar = await startBar({ width: 120, rows: 40, config: null, cwd: process.cwd(), ssh: false });
    expect(stripAnsi(await bar.render())).not.toContain("🎨 look");
    const opened = stripAnsi((await bar.click(DOOR_GLYPH)).rendered);
    expect(opened).toContain("🎨 look");
    expect(opened).toContain(DOOR_CLOSE_GLYPH);
  });

  test("a durable click writes the copy, never the file it started from", async () => {
    const original = userConfig();
    const before = fs.readFileSync(original, "utf8");
    bar = await startBar({ width: 120, rows: 40, config: original, cwd: process.cwd(), ssh: false });
    await bar.render();
    await bar.click(DOOR_GLYPH);
    await bar.click("📐 layout");
    // The second ▶ on screen: the first steps the preset control on the door's
    // line, the second the padding stepper in the layout tab.
    const { rendered: out } = await bar.click("▶", 2);
    // The stepper's step is a session draft; save writes it to the config.
    const save = drawnLinks(out).find((l) => describeLink(l).startsWith("save "));
    expect(save).toBeDefined();
    await bar.click(save!.text);
    expect(fs.readFileSync(bar.configPath, "utf8")).toMatch(/padding/);
    expect(fs.readFileSync(original, "utf8")).toBe(before);
  });

  test("a click the daemon refuses comes back with the strip that shows it", async () => {
    bar = await startBar({ width: 120, rows: 40, config: null, cwd: process.cwd(), ssh: false });
    await bar.render();
    await bar.click(DOOR_GLYPH);
    // No tmux server listens on the socket this session reports, so typing is refused.
    const { refused, rendered } = await bar.click("/compact");
    expect(refused).not.toBeNull();
    expect(stripAnsi(rendered)).toContain("⚠");
  });

  test("a click that rewrites the config file shows in the very next render", async () => {
    bar = await startBar({ width: 200, rows: 40, config: null, cwd: process.cwd(), ssh: false });
    await bar.render();
    await bar.click(DOOR_GLYPH);
    await bar.click("📐 layout");
    await bar.click("✎ arrange");
    // ✖ #1 is the risen door; #2 removes host, #3 directory.
    expect(stripAnsi((await bar.click("✖", 3)).rendered)).not.toContain("✖ directory");
    // Undo writes the file back; the render after it must already draw it.
    const { refused, rendered } = await bar.click("↶");
    expect(refused).toBeNull();
    expect(stripAnsi(rendered)).toContain("✖ directory");
  });

  test("a click that would act on this machine is not sent", async () => {
    bar = await startBar({ width: 120, rows: 40, config: null, cwd: process.cwd(), ssh: false });
    await bar.render();
    await bar.click(DOOR_GLYPH);
    const { refused } = await bar.click("⎘ id");
    expect(refused).toMatch(/^not sent: copy /);
  });

  test("a click on text the bar did not draw names what it drew", async () => {
    bar = await startBar({ width: 120, rows: 40, config: null, cwd: process.cwd(), ssh: false });
    await bar.render();
    await expect(bar.click("no such button")).rejects.toThrow(
      new RegExp(`drew no link "no such button" #1; it drew: .*"${DOOR_GLYPH}"`),
    );
  });
});
