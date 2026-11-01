// [LAW:no-silent-failure] Nothing a config authors makes a render throw
// (brandon-unfiled-3248.ryf), so check's catch of a thrown render
// (`loadRegisterRender`, src/check.ts) is reached only by a renderer bug. It is
// driven here by a drawDsl (the draw every pass of check goes through) that
// throws under one preset: that pass's throw is one failure tagged with the
// preset that reached it, and every other pass's failures are still reported
// beside it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkConfig } from "../src/check";

jest.mock("../src/dsl/render", () => {
  const actual =
    jest.requireActual<typeof import("../src/dsl/render")>("../src/dsl/render");
  return {
    ...actual,
    drawDsl: (...args: Parameters<typeof actual.drawDsl>) => {
      if (args[8].preset === "b") throw new Error("the renderer broke");
      return actual.drawDsl(...args);
    },
  };
});

let dir: string;
const SAVED_XDG = process.env.XDG_CONFIG_HOME;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-check-throws-"));
  // Only the explicit target is read: the developer's own config cannot leak in.
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg-empty");
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (SAVED_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = SAVED_XDG;
});

test("a render that throws under one preset is reported with that preset, beside every other failure", async () => {
  const p = path.join(dir, "throws.json5");
  fs.writeFileSync(
    p,
    `{
      globals: { preset: 'a' },
      actions: { cycleMode: { set: "work-mode", cycle: ["focus", "review", "debug"] } },
      presets: { a: {}, b: {} },
      segments: {
        broken: { template: '{{ action "cycleMode" "🎯 focus" "🔍 review" }}' },
      },
      root: { h: ['broken'] },
    }`,
  );
  const outcome = await checkConfig(p, dir);
  expect(outcome.kind).toBe("fatal");
  const message = outcome.kind === "fatal" ? outcome.message : "";
  expect(message).toContain("config renders with 2 render errors");
  expect(message).toMatch(/^ {2}segment "broken": /m);
  expect(message).toMatch(
    /^ {2}render: the renderer broke \(under preset "b"\)$/m,
  );
});
