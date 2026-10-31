// [LAW:verifiable-goals] What `pnpm bar` runs: a real daemon, started by the
// default of `startBar`. The rest of test/drive-bar.test.ts is about the bar.

import { startBar, type Bar } from "./helpers/drive-bar";
import { DOOR_CLOSE_GLYPH, DOOR_GLYPH } from "../src/config/disclosure";
import { stripAnsi } from "./helpers/ansi";

jest.setTimeout(30_000);

let bar: Bar | undefined;
afterEach(async () => bar?.stop());

test("a click on the door opens the menu in the next render", async () => {
  bar = await startBar({ width: 120, rows: 40, config: null, cwd: process.cwd(), ssh: false });
  expect(stripAnsi(await bar.render())).not.toContain("🎨 look");
  const opened = stripAnsi((await bar.click(DOOR_GLYPH)).rendered);
  expect(opened).toContain("🎨 look");
  expect(opened).toContain(DOOR_CLOSE_GLYPH);
});
