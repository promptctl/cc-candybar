// [LAW:verifiable-goals] A ◀ ▶ ? or page-arrow link means the same thing on
// every draw: it carries its step and never the value the draw computed, so a
// terminal that keeps the link it found when the mouse last moved still lands
// one step per click. Each test clicks one link N times with NO redraw between
// and shows N moves (spec §7, 'A link means the same thing on every draw').

import { linksOf } from "../src/click/read";
import { encodeSegments } from "../src/click/wire";
import { instantOf, type Instant } from "../src/utils/instant";
import { CLICK_VERBS } from "./helpers/click";
import { textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { CAROUSEL_NEXT, CAROUSEL_PREV } from "../src/render/carousel";
import { SWATCHES_RANDOM } from "../src/render/swatches";
import { buildRig, DEFAULT_DSL_CONFIG } from "./helpers/rig";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const SID = sessionIdOf("7qi");
const THEMES = listResolvablePaletteNames();

const rigOf = (source: string, width = 200) => {
  const rig = buildRig({ source, base: DEFAULT_DSL_CONFIG, sessionId: SID });
  const draw = (cols = width, at?: Instant): Frame =>
    rig.draw({ opts: { width: cols, wrap: true }, ...(at && { at }) }).frame;
  const urlOf = (frame: Frame, text: string): string => {
    const hit = linksOf(frame).find((l) => l.text === text);
    if (hit === undefined)
      throw new Error(`no link "${text}" in: ${textOf(frame)}`);
    return hit.url;
  };
  return { ...rig, draw, urlOf };
};

// A row of swatches over the session's theme, paged by its own cursor.
const SWATCHES = `{
  variables: { themesPage: { kind: 'state', key: 'themes-page', default: '0' } },
  actions: {
    applyTheme: { set: 'theme', from: 'themes' },
    themesPage: { set: 'themes-page', int: true },
  },
  segments: { row: { template: '{{ swatches "applyTheme" "themesPage" }}' } },
  root: { rows: { identity: { h: ['row'] }, status: { h: [] } } },
}`;

describe("a swatches row's ◀ ▶ ? land one step per click", () => {
  test("five clicks on one ▶ link, with no redraw, land five options on, and ◀ takes them back", async () => {
    const rt = rigOf(SWATCHES, 80);
    rt.sessionState.set(SID, "theme", THEMES[0]!);
    const first = rt.draw();
    const [next, prev] = [CAROUSEL_NEXT, CAROUSEL_PREV].map((g) =>
      rt.urlOf(first, g),
    );
    const landed: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      await rt.click(next!);
      landed.push(rt.sessionState.get(SID, "theme"));
    }
    expect(landed).toEqual(THEMES.slice(1, 6));
    landed.length = 0;
    for (let i = 0; i < 5; i++) {
      await rt.click(prev!);
      landed.push(rt.sessionState.get(SID, "theme"));
    }
    expect(landed).toEqual([
      THEMES[4],
      THEMES[3],
      THEMES[2],
      THEMES[1],
      THEMES[0],
    ]);
    // The links are the ones the first draw drew, drawn again.
    const again = rt.draw();
    expect([
      rt.urlOf(again, CAROUSEL_NEXT),
      rt.urlOf(again, CAROUSEL_PREV),
    ]).toEqual([next, prev]);
    rt.dispose();
  });

  test("a step turns the row to the page holding where it landed, from the layout the draw laid", async () => {
    const rt = rigOf(SWATCHES, 60);
    rt.sessionState.set(SID, "theme", THEMES[0]!);
    const prev = rt.urlOf(rt.draw(), CAROUSEL_PREV);
    await rt.click(prev);
    // The first option's ◀ is the last option, on the last page of the row.
    expect(rt.sessionState.get(SID, "theme")).toBe(THEMES.at(-1));
    const page = Number(rt.sessionState.get(SID, "themes-page"));
    expect(page).toBeGreaterThan(0);
    expect(textOf(rt.draw())).toContain("[▀▀▀]");
    rt.dispose();
  });

  test("the ? link is the same on every draw of one state, and each click lands an option other than the one held", async () => {
    const rt = rigOf(SWATCHES);
    rt.sessionState.set(SID, "theme", THEMES[0]!);
    const random = rt.urlOf(rt.draw(), SWATCHES_RANDOM);
    // Draws at other instants say the same link: no clock rides in it.
    for (const at of [1_000, 5_000_000, 987_654_321]) {
      const frame = rt.draw(200, instantOf(new Date(at)));
      expect(rt.urlOf(frame, SWATCHES_RANDOM)).toBe(random);
    }
    // Clicked with other values held, it still lands an option other than the one held.
    for (const held of [THEMES[0]!, THEMES[3]!, THEMES.at(-1)!, THEMES[0]!]) {
      rt.sessionState.set(SID, "theme", held);
      await rt.click(random);
      const landed = rt.sessionState.get(SID, "theme")!;
      expect(THEMES).toContain(landed);
      expect(landed).not.toBe(held);
    }
    rt.dispose();
  });

  // A theme chosen by a rule has no name until a render evaluates it, so the
  // click reads none from the session: the link carries the name the draw wore.
  test("a theme chosen by a rule steps from the name the bar wears, not from the first option", async () => {
    const ruled = SWATCHES.replace(
      "{\n  variables",
      "{\n  globals: { palette: '{{ \"nord\" }}' },\n  variables",
    );
    const at = THEMES.indexOf("nord");
    expect(at).toBeGreaterThan(1);
    const next = rigOf(ruled);
    await next.click(next.urlOf(next.draw(), CAROUSEL_NEXT));
    expect(next.sessionState.get(SID, "theme")).toBe(THEMES[at + 1]);
    const prev = rigOf(ruled);
    await prev.click(prev.urlOf(prev.draw(), CAROUSEL_PREV));
    expect(prev.sessionState.get(SID, "theme")).toBe(THEMES[at - 1]);
    next.dispose();
    prev.dispose();
  });

  test("a link whose page layout no longer covers the options is refused, not turned to a wrong page", () => {
    const rt = rigOf(SWATCHES);
    rt.draw();
    const [name, step, centre, pageKey] = [
      "applyTheme",
      "1",
      THEMES[0]!,
      "themes-page",
    ];
    expect(() =>
      CLICK_VERBS.get("ring-state")!(
        encodeSegments([SID, name!, step!, centre!, pageKey!, "0.3-1.3"]),
        rt.ctx,
      ),
    ).toThrow(/does not cover the \d+ option\(s\) now in the list/);
    expect(rt.sessionState.get(SID, "theme")).toBeNull();
    rt.dispose();
  });

  test("a ring step over an action that is no ring of options is refused, naming it", () => {
    const rt = rigOf(SWATCHES);
    rt.draw();
    expect(() =>
      CLICK_VERBS.get("ring-state")!(
        encodeSegments([SID, "themesPage", "1", ""]),
        rt.ctx,
      ),
    ).toThrow(/"themesPage" is not a set action over a list of options/);
    expect(() =>
      CLICK_VERBS.get("turn-page")!(
        encodeSegments([SID, "themesPage", "themes-page", "1", "", ""]),
        rt.ctx,
      ),
    ).toThrow(/"themesPage" lists no options to page through/);
    rt.dispose();
  });
});

// A paged picker over the session's theme at a width that forces pages.
const PICKER = `{
  variables: {
    themePick: { kind: 'state', key: 'theme-pick', default: '${THEMES[0]}' },
    page: { kind: 'state', key: 'theme-page', default: '0' },
  },
  actions: {
    applyTheme: { set: 'theme-pick', from: 'themes' },
    themePage: { set: 'theme-page', int: true },
  },
  segments: { menu: { template: '{{ picker "applyTheme" "themePage" false true }}' } },
  root: { rows: { identity: { h: ['menu'] }, status: { h: [] } } },
}`;

describe("a picker's page arrows turn one page per click", () => {
  test("five clicks on one → link, with no redraw, turn five pages, and keep stopping at the last", async () => {
    const rt = rigOf(PICKER, 30);
    const next = rt.urlOf(rt.draw(), "→");
    const cursor = (): number => Number(rt.sessionState.get(SID, "theme-page"));
    const turned: number[] = [];
    for (let i = 0; i < 5; i++) {
      await rt.click(next);
      turned.push(cursor());
    }
    expect(turned).toEqual([1, 2, 3, 4, 5]);
    // A stale link past the end stays on the last page, as the draw's arrows do.
    for (let i = 0; i < THEMES.length; i++) await rt.click(next);
    const last = cursor();
    expect(last).toBeGreaterThan(5);
    const shown = rt.draw();
    expect(linksOf(shown).some((l) => l.text === "→")).toBe(false);
    expect(linksOf(shown).some((l) => l.text === "←")).toBe(true);
    rt.dispose();
  });

  test("five clicks on one ← link, with no redraw, turn five pages back, and stop at the first", async () => {
    const rt = rigOf(PICKER, 30);
    rt.sessionState.set(SID, "theme-page", "7");
    const prev = rt.urlOf(rt.draw(), "←");
    const cursor = (): number => Number(rt.sessionState.get(SID, "theme-page"));
    const turned: number[] = [];
    for (let i = 0; i < 5; i++) {
      await rt.click(prev);
      turned.push(cursor());
    }
    expect(turned).toEqual([6, 5, 4, 3, 2]);
    for (let i = 0; i < 5; i++) await rt.click(prev);
    expect(cursor()).toBe(0);
    rt.dispose();
  });

  test("a page arrow is the same link on every page of one layout", async () => {
    const rt = rigOf(PICKER, 30);
    const next = rt.urlOf(rt.draw(), "→");
    await rt.click(next);
    expect(rt.urlOf(rt.draw(), "→")).toBe(next);
    rt.dispose();
  });

  test("a cursor below zero turns from the page holding the option in force", async () => {
    const rt = rigOf(PICKER, 30);
    rt.sessionState.set(SID, "theme-pick", THEMES.at(-1)!);
    rt.sessionState.set(SID, "theme-page", "-1");
    const shown = rt.draw();
    expect(linksOf(shown).some((l) => l.text === "→")).toBe(false);
    const prev = rt.urlOf(shown, "←");
    await rt.click(prev);
    const held = Number(rt.sessionState.get(SID, "theme-page"));
    // One page back from the last page the layout holds.
    await rt.click(rt.urlOf(rt.draw(), "→"));
    expect(Number(rt.sessionState.get(SID, "theme-page"))).toBe(held + 1);
    rt.dispose();
  });
});

describe("a stepped control over a do", () => {
  const over = (members: string): string => `{
    variables: { pick: { kind: 'state', key: 'pick', default: 'a' } },
    actions: {
      choose: { set: 'pick', from: ['a', 'b', 'c'] },
      list: { set: 'listing', to: 'yes' },
      other: { set: 'other', from: ['x', 'y', 'z'] },
      both: { do: [${members}] },
    },
    segments: { ring: { template: '{{ carousel "both" "list" "the pick" }}' } },
    root: { rows: { identity: { h: ['ring'] }, status: { h: [] } } },
  }`;

  test("steps its head's ring, and its other members ride behind", async () => {
    const rt = rigOf(
      `{
    variables: { pick: { kind: 'state', key: 'pick', default: 'a' } },
    actions: {
      choose: { set: 'pick', from: ['a', 'b', 'c'] },
      list: { set: 'listing', to: 'yes' },
      both: { do: ['choose', 'list'] },
    },
    segments: { ring: { template: '{{ carousel "both" "list" "the pick" }}' } },
    root: { rows: { identity: { h: ['ring'] }, status: { h: [] } } },
  }`,
    );
    const next = rt.urlOf(rt.draw(), CAROUSEL_NEXT);
    for (const expected of ["b", "c", "a"]) {
      await rt.click(next);
      expect(rt.sessionState.get(SID, "pick")).toBe(expected);
    }
    expect(rt.sessionState.get(SID, "listing")).toBe("yes");
    rt.dispose();
  });

  // The ring relies on this: a member behind the head never takes the
  // template's value, so none writes an option other than the one the step lands.
  test("a member behind the head that takes the template's value is refused at load", () => {
    expect(() => rigOf(over("'choose', 'other'"))).toThrow(
      /takes its value from the template, so it can only be the first member/,
    );
  });
});
