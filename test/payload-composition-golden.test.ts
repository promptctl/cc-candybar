// The pin under the payload's composition (candybar-gather-renderer-76bb.6pj.83l):
// the bundled default and every preset, drawn from the daemon's own session
// source over fixed owners at a fixed instant, pin two things apart — the bar's
// bytes and the payload a template reads. The bar must not move when the
// payload is composed from the facts document; the payload's snapshot is where
// the accepted differences of that change show as a diff, and nothing else may.
// `check`'s payload is pinned the same way, per preset.
//
// [LAW:behavior-not-structure] Asserts what a viewer sees and what a template
// reads, over owners that answer fixed values; no composition function is named.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPayload } from "../src/check";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { UNFOLLOWED_FEEDS } from "../src/config/lanes";
import { presetNames } from "../src/config/presets";
import { renderOptionsOf, todayOf } from "../src/daemon/render-payload";
import { drawDsl } from "../src/dsl/render";
import { ansiOf } from "../src/render/frame";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { AT, openSettled, sessionRig } from "./helpers/session-rig";

const COLS = 120;

let dir: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-golden-")));
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

// A session's view under `preset`, then the bar it draws at AT and the payload
// it draws from.
async function drawnUnder(preset: string | null) {
  const view = await openSettled(
    sessionRig(dir, cleanups),
    dir,
    cleanups,
    preset,
  );
  const effective = view.source.effective();
  const { frame } = drawDsl(
    view.state.config,
    view.state.compiled,
    view.store,
    view.registry,
    {
      drawing: { by: "request" },
      feeds: UNFOLLOWED_FEEDS,
      today: todayOf(view.source.facts().builtins.today, AT),
    },
    AT,
    renderOptionsOf(effective, COLS),
    {},
    effective,
  );
  // The temporary directory is the one thing a run names that differs.
  const unnamed = (text: string): string => text.split(dir).join("<dir>");
  return {
    bar: unnamed(ansiOf(frame)),
    payload: JSON.parse(unnamed(JSON.stringify(view.source.payload()))) as unknown,
  };
}

const PRESETS = presetNames(DEFAULT_DSL_CONFIG.presets);

describe("a session's view, drawn from fixed owners at a fixed instant", () => {
  test.each([null, ...PRESETS])("preset %s: the bar", async (preset) => {
    expect((await drawnUnder(preset)).bar).toMatchSnapshot();
  });

  test.each([null, ...PRESETS])(
    "preset %s: the payload a template reads",
    async (preset) => {
      expect((await drawnUnder(preset)).payload).toMatchSnapshot();
    },
  );
});

describe("`check`'s representative payload", () => {
  const config = parseAndValidate(
    "<user>",
    "{}",
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );

  test.each(PRESETS)("preset %s: the payload and its day", (preset) => {
    const effective = resolveEffectiveGlobals(
      config,
      (key) => (key === "preset" ? preset : null),
      () => false,
    );
    const { today, ...payload } = checkPayload(config, effective, null, AT);
    expect({ payload, today }).toMatchSnapshot();
  });
});
