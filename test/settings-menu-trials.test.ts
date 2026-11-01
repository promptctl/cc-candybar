// [LAW:verifiable-goals] A setting's trial looks sit in its one list, each
// marked 🧪: its label is what the list shows, and its value is what the click
// writes. Driven through the real loader and `renderDsl`.

import { sharedMenuStateKey } from "../src/config/menu-keys";
import { resolveOptionDomain } from "../src/config/option-domain";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";
import { TRIAL_SHADE_NAMES, TRIAL_VARIATION_NAMES } from "../src/themes/policy";
import { instantOf } from "../src/utils/instant";
import { effectsOf } from "./helpers/click";
import { links, stripAnsi } from "./helpers/ansi";
import { sessionBar } from "./helpers/session-bar";

function menu() {
  const bar = sessionBar(`{}`, 400);
  const raw = (): string => bar.render(instantOf(new Date())).text;
  const open = (list: string): string => {
    bar.pick(SETTINGS_ANCHOR, SETTINGS_OPEN);
    bar.pick(sharedMenuStateKey(`${SETTINGS_NS}pickers`), "gear");
    bar.pick(sharedMenuStateKey(`${SETTINGS_NS}gearPickers`), list);
    return raw();
  };
  const writes = (text: string, key: string): string[] =>
    links(text)
      .flatMap((l) => effectsOf(l.url))
      .filter((e) => e.args[1] === key)
      .map((e) => e.args[2]!);
  return {
    open,
    writes,
    set: (key: string, value: string) => bar.pick(key, value),
  };
}

test.each([
  ["variation", TRIAL_VARIATION_NAMES, "duo"],
  ["shade", TRIAL_SHADE_NAMES, "muted"],
] as const)(
  "%s's one list marks its trials and writes their plain values",
  (setting, trials, shipped) => {
    const { open, writes } = menu();
    const list = open(`${SETTINGS_NS}apply.${setting}`);
    const shown = links(list).map((l) => stripAnsi(l.text).trim());
    for (const trial of trials) {
      expect(shown).toContain(`🧪 ${trial}`);
      expect(writes(list, setting)).toContain(trial);
    }
    expect(shown).toContain(shipped);
    expect(shown).not.toContain("🧪 trials");
  },
);

test("a value on trial is on its ring: ▶ steps on from it", () => {
  const { open, set } = menu();
  set("shade", TRIAL_SHADE_NAMES[0]!);
  const next = links(open(`${SETTINGS_NS}apply.shade`))
    .filter((l) => stripAnsi(l.text) === "▶")
    .flatMap((l) => effectsOf(l.url))
    .filter((e) => e.args[1] === "shade");
  expect(next.map((e) => e.args[2])).toEqual([TRIAL_SHADE_NAMES[1]]);
});

test.each(["variations", "shades"])(
  "the trial mark is %s's own, so any picker over it shows it",
  (name) => {
    const { members, labelOf } = resolveOptionDomain(name, new Map());
    const labels = members.map(labelOf!);
    expect(labels.filter((l) => l.startsWith("🧪 ")).length).toBeGreaterThan(0);
    expect(labels.map((l) => l.replace("🧪 ", ""))).toEqual(members);
  },
);
