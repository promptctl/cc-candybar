// [LAW:verifiable-goals] The trial looks (brandon-menus-sjhy.4fi's tunings of
// the accent variation and its wider jumps) sit in a menu of their own:
// Brandon, "put them in a separate menu". The theme's ⚙ holds a 🧪 trials
// submenu whose pickers offer exactly the rows a setting names as trials, and
// the 🎼 and 🔆 carousels everyone turns offer none of them. Driven through the
// real loader, `resolveEffectiveGlobals` and `renderDsl`.

import { TEST_SIGNER } from "./helpers/link-signer";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { sharedMenuStateKey } from "../src/config/menu-keys";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";
import { perSetting } from "../src/config/setting-projections";
import { CHECK_TODAY, checkPayload } from "../src/check";
import { renderOptionsOf } from "../src/daemon/render-payload";
import { SessionState } from "../src/daemon/session-state";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { listResolvablePaletteNames, TRIAL_SHADE_NAMES, TRIAL_VARIATION_NAMES } from "../src/themes/policy";
import { instantOf } from "../src/utils/instant";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { stripAnsi } from "./helpers/ansi";
import { parseAndValidate } from "./helpers/parse-and-validate";

const SID = "trials0a-2c3d-4e5f-8a7b-8c9d0e1f2a3b";
const COLS = 400;

function menu() {
  const config = parseAndValidate("<user>", `{}`, new Set(listResolvablePaletteNames()), DEFAULT_DSL_CONFIG);
  const session = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", session);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/home/tester/code/project" });
  const render = (): string => {
    const effective = resolveEffectiveGlobals(config, (key) => session.get(SID, key) ?? null, () => false);
    const at = instantOf(new Date());
    const payload = {
      ...checkPayload(config, effective, null, at),
      today: CHECK_TODAY,
      resettable: perSetting(() => false),
      unsaved: 0,
      history: { undo: 0, redo: 0 },
      session_id: SID,
      term: { cols: COLS },
    };
    return stripAnsi(
      renderDsl(config, compiled, store, registry, payload, at, renderOptionsOf(effective, COLS), {
        onSegmentError: (name, message) => {
          throw new Error(`${name}: ${message}`);
        },
      }, effective),
    );
  };
  const open = (gearPick: string, trialsPick?: string): string => {
    session.set(SID, SETTINGS_ANCHOR, SETTINGS_OPEN);
    session.set(SID, sharedMenuStateKey(`${SETTINGS_NS}pickers`), "gear");
    session.set(SID, sharedMenuStateKey(`${SETTINGS_NS}gearPickers`), gearPick);
    if (trialsPick !== undefined) session.set(SID, sharedMenuStateKey(`${SETTINGS_NS}trialsPickers`), trialsPick);
    return render();
  };
  return { open, set: (key: string, value: string) => session.set(SID, key, value) };
}

const anyOf = (text: string, names: readonly string[]): string[] => names.filter((name) => text.includes(name));

test("the theme's ⚙ holds 🧪 trials, and its own 🎼 and 🔆 offer no trial look", () => {
  const { open } = menu();
  // Each list open, showing its shipped looks, so "none of the trials" is not
  // the answer of a list that never opened.
  for (const [list, shipped] of [
    [`${SETTINGS_NS}apply.variation`, ["duo", "mono", "alt"]],
    [`${SETTINGS_NS}apply.shade`, ["deepest", "brightest", "muted"]],
  ] as const) {
    const shown = open(list);
    expect(shown).toContain("🧪 trials");
    expect(anyOf(shown, shipped)).toEqual(shipped);
    expect(anyOf(shown, [...TRIAL_VARIATION_NAMES, ...TRIAL_SHADE_NAMES])).toEqual([]);
  }
});

test("🧪 trials offers each setting's trial looks, and one applied shows as that setting's value", () => {
  const { open, set } = menu();
  const variations = open("trials", `${SETTINGS_NS}apply.variation.trials`);
  expect(anyOf(variations, TRIAL_VARIATION_NAMES).length).toBeGreaterThan(0);
  const shades = open("trials", `${SETTINGS_NS}apply.shade.trials`);
  expect(anyOf(shades, TRIAL_SHADE_NAMES).length).toBeGreaterThan(0);
  // A trial pick is the setting's value like any other: the bar reads it back.
  set("shade", "pair");
  set("variation", "start-primary");
  const applied = open("trials");
  expect(applied).toContain("pair");
  expect(applied).toContain("start-primary");
});
