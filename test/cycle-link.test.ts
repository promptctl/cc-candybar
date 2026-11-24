// A cycle's link means the same thing on every draw: it names the action and
// the step, and the member it lands on is read when the click arrives. So
// clicks that land before the bar redraws add up, where a link that named the
// member would repeat the first.

import { buildRig, type Rig } from "./helpers/rig";
import { linkUrls } from "./helpers/frame";
import {
  clickUrl,
  clickVerb,
  effectsOf,
  menuTriggerOf,
  testVerbContext,
} from "./helpers/click";
import { menuPageKey } from "../src/config/menu-keys";
import { effectsUrl, VERB_DISPATCH } from "../src/click/wire";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { parseAndValidate } from "../scripts/lib/draw-fixtures/parse-and-validate";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const S1 = sessionIdOf("s1");
const ALLOWED = new Set(listResolvablePaletteNames());

const cycleSource = (members: string) => `{
  variables: { mode: { kind: 'state', key: 'mode', default: 'off' } },
  actions: { flip: { set: 'mode', cycle: [${members}] } },
  segments: { bar: { template: '{{ action "flip" "mode" }}' } },
  root: 'bar',
}`;

// The bar's link that steps the `flip` cycle.
const flipLink = (rig: Rig): string =>
  linkUrls(rig.draw().frame).find((u) =>
    effectsOf(u).some((e) => e.verb === "ring-state" && e.args[1] === "flip"),
  )!;

describe("a state cycle's link", () => {
  test("clicked five times with no redraw steps five times through its members", async () => {
    const rig = buildRig({ source: cycleSource("'a', 'b', 'c'"), sessionId: S1 });
    const url = flipLink(rig);
    const landed: (string | null)[] = [];
    for (let n = 0; n < 5; n++) {
      await clickUrl(url, rig.ctx);
      landed.push(rig.sessionState.get(S1, "mode"));
    }
    // A key holding no member counts as the first, so the first step lands on
    // the second.
    expect(landed).toEqual(["b", "c", "a", "b", "c"]);
  });

  test("is byte-identical on every draw, whatever value its key holds", () => {
    const rig = buildRig({ source: cycleSource("'a', 'b', 'c'"), sessionId: S1 });
    const drawn = new Set<string>();
    for (const held of [null, "a", "b", "c", "not-a-member"]) {
      if (held === null) rig.sessionState.clear(S1, "mode");
      else rig.sessionState.set(S1, "mode", held);
      drawn.add(flipLink(rig));
    }
    expect([...drawn]).toHaveLength(1);
  });

  test("a link drawn before a reload steps through the members the reloaded config declares", async () => {
    const before = buildRig({ source: cycleSource("'off', 'on'"), sessionId: S1 });
    const url = flipLink(before);
    const after = parseAndValidate(
      "<reloaded>",
      cycleSource("'off', 'auto', 'on'"),
      ALLOWED,
      DEFAULT_DSL_CONFIG,
    );
    before.sessionState.set(S1, "mode", "off");
    await clickUrl(url, testVerbContext(before.sessionState, undefined, after));
    expect(before.sessionState.get(S1, "mode")).toBe("auto");
  });
});

describe("a menu trigger", () => {
  const SRC = `{
    segments: { picker: { template: 'T {{ menu "applyTheme" "▸" "▾" }}' } },
    actions: { applyTheme: { set: 'theme', from: 'themes' } },
    root: 'picker',
  }`;
  const opener = () => {
    const rig = buildRig({ source: SRC, palettes: ALLOWED, sessionId: S1 });
    const url = linkUrls(rig.draw().frame).find(
      (u) => menuTriggerOf(rig.config, effectsOf(u))?.member === "applyTheme",
    )!;
    const { key, member } = menuTriggerOf(rig.config, effectsOf(url))!;
    return { rig, url, key, member, page: menuPageKey(key) };
  };

  test("clicked twice with no redraw opens then closes, and every open lands on the first page", async () => {
    const { rig, url, key, member, page } = opener();
    for (const left of ["3", "-1"]) {
      rig.sessionState.set(S1, page, left);
      await clickUrl(url, rig.ctx);
      expect(rig.sessionState.get(S1, key)).toBe(member);
      expect(rig.sessionState.get(S1, page)).toBe("0");
      await clickUrl(url, rig.ctx);
      expect(rig.sessionState.get(S1, key)).toBe("closed");
    }
  });

  test("its step and its page reset land together or not at all", () => {
    const { rig, url, key, page } = opener();
    const [step] = effectsOf(url).filter((e) => e.verb === "ring-state");
    // The same step, beside a page write the gate refuses.
    const refused = effectsUrl([
      { verb: "ring-state", args: step!.args },
      { verb: "set-state", args: [S1, page, "not-a-page"] },
    ]);
    expect(() =>
      clickVerb(
        VERB_DISPATCH,
        refused.slice(`cc-candybar://${VERB_DISPATCH}/`.length),
        rig.ctx,
      ),
    ).toThrow();
    expect(rig.sessionState.get(S1, key)).toBeNull();
    expect(rig.sessionState.get(S1, page)).toBeNull();
  });
});
