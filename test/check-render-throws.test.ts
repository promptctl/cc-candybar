// [LAW:no-silent-failure] Nothing a config authors makes a render throw
// (brandon-unfiled-3248.ryf), so a request turn of check's bar that throws is
// a renderer bug. It is driven here by the main renderer wrapped to throw on
// the request turn of the session whose stored pick is preset "b": that
// pass's throw is one failure tagged with the preset that reached it, and
// every other pass's failures are still reported beside it.

import fs from "node:fs";
import { HOST, hostOf, worldOf } from "./helpers/host";
import type { World } from "../src/host";
import os from "node:os";
import path from "node:path";

import { checkConfig } from "../src/check";
import { daemonGates } from "../src/daemon/foundations/update-keys";
import { mainRendererOf } from "../src/renderer/main";
import { rendererOf } from "../src/renderer-interface/interface";
import type { RendererBuilder } from "../src/daemon/local-bar";

let dir: string;
let world: World;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-check-throws-"));
  // Only the explicit target is read: the developer's own config cannot leak in.
  world = worldOf(hostOf({ ...HOST.env, XDG_CONFIG_HOME: path.join(dir, "xdg-empty") }));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// The main renderer, whose request turn for the session picking preset "b"
// throws as a renderer bug would.
const breaksUnderB: RendererBuilder = (inputs, host) => {
  const renderer = mainRendererOf(inputs, host);
  const picksB = new Set(
    Object.entries(inputs.stored.sessions).flatMap(([session, picks]) =>
      picks.preset === "b" ? [session] : [],
    ),
  );
  return rendererOf({
    event: (input) => {
      const { event } = input;
      if (event.kind === "request" && picksB.has(event.context.hookData.session_id))
        throw new Error("the renderer broke");
      return renderer.answer(input);
    },
    adapter: (input) => renderer.answer(input),
  });
};

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
  const outcome = await checkConfig(world, daemonGates(), p, dir, undefined, breaksUnderB);
  expect(outcome.kind).toBe("fatal");
  const message = outcome.kind === "fatal" ? outcome.message : "";
  expect(message).toContain("config renders with 2 render errors");
  expect(message).toMatch(/^ {2}segment "broken": /m);
  expect(message).toMatch(
    /^ {2}render: the renderer broke \(under preset "b"\)$/m,
  );
});
