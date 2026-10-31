// [LAW:verifiable-goals] The trial looks (brandon-menus-sjhy.4fi's tunings of
// the accent variation and its wider jumps) sit in a menu of their own:
// Brandon, "put them in a separate menu". The theme's ⚙ holds a 🧪 trials
// submenu whose pickers offer exactly the rows a setting names as trials, and
// the 🎼 and 🔆 carousels everyone turns offer none of them. Driven through the
// real loader, `resolveEffectiveGlobals` and `renderDsl`.

import { sharedMenuStateKey } from "../src/config/menu-keys";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";
import { TRIAL_SHADE_NAMES, TRIAL_VARIATION_NAMES } from "../src/themes/policy";
import { instantOf } from "../src/utils/instant";
import { effectsOf } from "./helpers/click";
import { links, stripAnsi } from "./helpers/ansi";
import { sessionBar } from "./helpers/session-bar";

const COLS = 400;

function menu() {
  const bar = sessionBar(`{}`, COLS);
  const raw = (): string => bar.render(instantOf(new Date())).text;
  const render = (): string => stripAnsi(raw());
  const open = (gearPick: string, trialsPick?: string): string => {
    bar.pick(SETTINGS_ANCHOR, SETTINGS_OPEN);
    bar.pick(sharedMenuStateKey(`${SETTINGS_NS}pickers`), "gear");
    bar.pick(sharedMenuStateKey(`${SETTINGS_NS}gearPickers`), gearPick);
    if (trialsPick !== undefined) bar.pick(sharedMenuStateKey(`${SETTINGS_NS}trialsPickers`), trialsPick);
    return render();
  };
  // What each ▶ writing `key` steps to, in bar order.
  const steps = (key: string): string[] =>
    links(raw())
      .filter((l) => stripAnsi(l.text) === "▶")
      .flatMap((l) => effectsOf(l.url))
      .filter((e) => e.args[1] === key)
      .map((e) => e.args[2]!);
  return { open, steps, set: (key: string, value: string) => bar.pick(key, value) };
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

test("🧪 trials offers each setting's trial looks, and one applied is that setting's value", () => {
  const { open, set, steps } = menu();
  const variations = open("trials", `${SETTINGS_NS}apply.variation.trials`);
  expect(anyOf(variations, TRIAL_VARIATION_NAMES).length).toBeGreaterThan(0);
  const shades = open("trials", `${SETTINGS_NS}apply.shade.trials`);
  expect(anyOf(shades, TRIAL_SHADE_NAMES).length).toBeGreaterThan(0);
  // A trial pick is the setting's value like any other: the trials' ▶ steps on
  // from it.
  set("shade", TRIAL_SHADE_NAMES[0]!);
  set("variation", TRIAL_VARIATION_NAMES[0]!);
  open("trials");
  expect(steps("shade")).toContain(TRIAL_SHADE_NAMES[1]);
  expect(steps("variation")).toContain(TRIAL_VARIATION_NAMES[1]);
});

test("a picker that does not offer the value in force steps from its first option", () => {
  const { open, set, steps } = menu();
  set("variation", "duo");
  open("trials");
  // The trials ring lacks `duo`, so it counts it as its first member.
  expect(steps("variation")).toContain(TRIAL_VARIATION_NAMES[1]);
});
