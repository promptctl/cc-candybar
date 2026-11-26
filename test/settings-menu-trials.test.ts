// [LAW:verifiable-goals] A setting's trial looks sit in its one list, each
// marked 🧪: its label is what the list shows, and its value is what the click
// writes. Driven through the real loader and `drawDsl`.

import { linksOf } from "../src/click/read";
import { sharedMenuStateKey } from "../src/config/menu-keys";
import { resolveOptionDomain } from "../src/config/option-domain";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/reserved-names";
import type { Frame } from "../src/render/frame";
import { TRIAL_SHADE_NAMES, TRIAL_VARIATION_NAMES } from "../src/themes/policy";
import { instantOf } from "../src/utils/instant";
import { effectsOf } from "./helpers/click";
import { sessionBar } from "../scripts/lib/draw-fixtures/session-bar";
import { buildRig, DEFAULT_DSL_CONFIG } from "./helpers/rig";

function menu() {
  const bar = sessionBar(`{}`, 400);
  const raw = (): Frame => bar.render(instantOf(new Date())).frame;
  const open = (list: string): Frame => {
    bar.pick(SETTINGS_ANCHOR, SETTINGS_OPEN);
    bar.pick(`${SETTINGS_NS}tab`, "look");
    bar.pick(sharedMenuStateKey(`${SETTINGS_NS}pickers`), "gear");
    bar.pick(sharedMenuStateKey(`${SETTINGS_NS}gearPickers`), list);
    return raw();
  };
  const writes = (frame: Frame, key: string): string[] =>
    linksOf(frame)
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
    const shown = linksOf(list).map((l) => l.text);
    for (const trial of trials) {
      expect(shown).toContain(`🧪 ${trial}`);
      expect(writes(list, setting)).toContain(trial);
    }
    expect(shown).toContain(shipped);
    expect(shown).not.toContain("🧪 trials");
  },
);

// The ring is the shade action's own list, trials included, centred on the
// value the bar wears when the click arrives.
test("a value on trial is on its ring: ▶ steps on from it", async () => {
  const rig = buildRig({ base: DEFAULT_DSL_CONFIG });
  const { sessionState, sessionId } = rig;
  sessionState.set(sessionId, SETTINGS_ANCHOR, SETTINGS_OPEN);
  sessionState.set(sessionId, `${SETTINGS_NS}tab`, "look");
  sessionState.set(
    sessionId,
    sharedMenuStateKey(`${SETTINGS_NS}pickers`),
    "gear",
  );
  sessionState.set(
    sessionId,
    sharedMenuStateKey(`${SETTINGS_NS}gearPickers`),
    `${SETTINGS_NS}apply.shade`,
  );
  sessionState.set(sessionId, "shade", TRIAL_SHADE_NAMES[0]!);
  const next = linksOf(rig.draw({ opts: { width: 400 } }).frame).find(
    (l) =>
      l.text === "▶" &&
      effectsOf(l.url).some((e) => e.args[1] === `${SETTINGS_NS}apply.shade`),
  );
  expect(next).toBeDefined();
  await rig.click(next!.url);
  expect(sessionState.get(sessionId, "shade")).toBe(TRIAL_SHADE_NAMES[1]);
  rig.dispose();
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
