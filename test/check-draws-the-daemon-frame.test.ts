// [LAW:single-enforcer] `check` draws through the daemon's renderer, so the
// bar it prints is the frame the renderer presented for the fresh session's
// request, and each preset's pass is one request the renderer answers with
// one present.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HOST, hostOf, worldOf } from "./helpers/host";
import type { World } from "../src/host";
import { checkConfig } from "../src/check";
import { daemonGates } from "../src/daemon/foundations/update-keys";
import { mainRendererOf } from "../src/renderer/main";
import {
  rendererOf,
  type Present,
} from "../src/renderer-interface/interface";
import type { RendererBuilder } from "../src/daemon/local-bar";
import { parseFrame } from "../src/render/frame";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { presetNames } from "../src/config/presets";

let dir: string;
let world: World;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-check-frame-"));
  // Only the explicit target is read: the developer's own config cannot leak in.
  world = worldOf(hostOf({ ...HOST.env, XDG_CONFIG_HOME: path.join(dir, "xdg-empty") }));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("check's bar is the frame the renderer presented for the fresh session, one present per preset", async () => {
  const p = path.join(dir, "presets.json5");
  fs.writeFileSync(
    p,
    `{
      globals: { preset: 'a' },
      presets: { a: {}, b: {}, c: {} },
      segments: { hello: { template: 'hello' } },
      root: { h: ['hello'] },
    }`,
  );
  const presents: Present[] = [];
  const spying: RendererBuilder = (inputs, host) => {
    const renderer = mainRendererOf(inputs, host);
    return rendererOf({
      event: async (input) => {
        const output = await renderer.answer(input);
        presents.push(
          ...output.effects.flatMap((e) => (e.kind === "present" ? [e] : [])),
        );
        return output;
      },
      adapter: (input) => renderer.answer(input),
    });
  };
  const outcome = await checkConfig(world, daemonGates(), p, dir, undefined, spying);
  if (outcome.kind !== "clean") throw new Error(`check was ${outcome.kind}`);
  // Every preset the merged chain names: the bundled default's and this
  // config's.
  const passes = presetNames({ ...DEFAULT_DSL_CONFIG.presets, a: {}, b: {}, c: {} });
  expect(presents).toHaveLength(passes.length);
  expect(new Set(presents.map((pr) => pr.session)).size).toBe(passes.length);
  const [fresh] = presents;
  expect(outcome.rendered).toEqual(parseFrame(fresh!.frame));
});
