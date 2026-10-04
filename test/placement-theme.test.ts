// [LAW:verifiable-goals] brandon-settings-menu-6c5 — theme is a setting every
// placement has, driven through the real loader, the real render, and clicks
// through the real daemon verbs over a real config file.
//
//   - Every placement has `theme` without its segment declaring it: `bar`
//     (follow the bar's theme) or an installed theme name.
//   - A placement's theme recolours that placement alone; a pinned one holds
//     when the bar's theme moves, and `bar` follows it again.
//   - `segments.<name>.palette` is the default for every copy of the segment.
//   - Configure mode picks it from a carousel whose options paint in the
//     palette picking them would put on the placement, and save writes the
//     pick into the placement.

import { configurePlacement } from "./helpers/configure";
import type { Palette, RichText } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import {
  FOLLOW_BAR,
  listResolvablePaletteNames,
} from "../src/themes/policy";
import { paletteForThemeName } from "../src/themes/palette-resolvers";
import { definedStyle } from "../src/template-engine/cells";
import { settingsOf } from "../src/config/dsl-types";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { parseEffects, VERB_DISPATCH, VERB_SAVE } from "../src/click/wire";
import { VERBS, type VerbContext } from "../src/daemon/verbs";
import { stateGate } from "../src/daemon/verbs/state-validators";
import {
  configureMember,
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../src/config/loader/edit-mode";
import { placementDraftKey } from "../src/config/edit-chrome";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import { linkUrls, stripAnsi } from "./helpers/ansi";

const ALLOWED = new Set(listResolvablePaletteNames());
const SID = "s1";
const PIN = "nord";
const BAR_A = "gruvbox";
const BAR_B = "dracula";

// Two placements of one segment: one follows the bar, one wears its own.
const configWith = (segment: string, placements: string): string => `{
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
  },
  segments: { tag: ${segment} },
  root: { v: [{ h: [${placements}] }] },
}`;
const TWO = configWith(
  "{ template: '{{ .settings.theme }}' }",
  `'tag', { seg: 'tag', id: 'pinned', settings: { theme: '${PIN}' } }`,
);

let durable: DurableConfig;
beforeEach(() => {
  durable = durableConfig("cc-candybar-placement-theme-");
});
afterEach(() => {
  durable.dispose();
});

const decided = (name: string) => ({
  kind: "decided" as const,
  name,
  value: paletteForThemeName(name),
});

function buildRuntime(src: string, sessionState = new SessionState()) {
  const config = parseAndValidate("<test>", src, ALLOWED);
  durable.seedOrigin(sessionState, SID);
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
  let sink = new Map<string, readonly RichText[]>();
  const render = (barTheme = BAR_A): string => {
    sink = new Map();
    return renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: SID, project_dir: "/tmp/proj" },
      {
        endcaps: "powerline" as const,
        colorCompatibility: "truecolor" as const,
        wrap: true,
        padding: 0,
        charset: "unicode" as const,
        width: 200,
      },
      { perSegmentSink: sink },
      { theme: decided(barTheme) },
    );
  };
  // The background a placement's cell wears, read by its id.
  const bgOf = (id: string): string => {
    const cell = sink.get(id)?.[0];
    if (cell === undefined) throw new Error(`placement "${id}" did not render`);
    return definedStyle(cell.style).bgcolor!.value!.hex;
  };
  let current = config;
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, durable.historyFor(sessionState)),
    configFor: () => current,
    reloadConfig: () => {
      current = parseAndValidate("<reloaded>", durable.text()!, ALLOWED);
    },
  };
  const click = (url: string): void => {
    const { verb, value } = parseHandlerUrl(url);
    const effects =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    for (const e of effects) VERBS.get(e.verb)!(e.value, ctx);
  };
  return { config, compiled, sessionState, render, bgOf, click, ctx };
}

const hex = (palette: Palette, role: "background"): string =>
  palette.get(role)!.hex;

describe("the theme domain", () => {
  test("`bar` names no installed theme, so following and pinning never collide", () => {
    expect(listResolvablePaletteNames()).not.toContain(FOLLOW_BAR);
  });

  test("every segment has `theme`, defaulting to its definition's palette, else the bar", () => {
    expect(settingsOf({ template: "x" }).theme).toMatchObject({
      domain: "theme",
      default: FOLLOW_BAR,
    });
    expect(settingsOf({ template: "x", palette: PIN }).theme).toMatchObject({
      default: PIN,
    });
  });
});

describe("a placement's theme recolours that placement alone", () => {
  test("a pinned placement holds when the bar's theme moves; its sibling follows", () => {
    const rt = buildRuntime(TWO);
    const underA = stripAnsi(rt.render(BAR_A));
    const [followA, pinnedA] = [rt.bgOf("tag"), rt.bgOf("pinned")];
    rt.render(BAR_B);
    const [followB, pinnedB] = [rt.bgOf("tag"), rt.bgOf("pinned")];
    expect(followB).not.toBe(followA);
    expect(pinnedB).toBe(pinnedA);
    // The template reads the placement's own value.
    expect(underA).toContain(FOLLOW_BAR);
    expect(underA).toContain(PIN);
  });

  test("a pinned placement wears exactly what it would when the bar is that theme", () => {
    const pinned = buildRuntime(TWO);
    pinned.render(BAR_A);
    const following = buildRuntime(
      configWith("{ template: 'x' }", `'tag', { seg: 'tag', id: 'pinned' }`),
    );
    following.render(PIN);
    expect(pinned.bgOf("pinned")).toBe(following.bgOf("pinned"));
  });

  test("a definition's palette pins every copy, and a placement's `bar` follows again", () => {
    const rt = buildRuntime(
      configWith(
        `{ template: 'x', palette: '${PIN}' }`,
        `'tag', { seg: 'tag', id: 'free', settings: { theme: 'bar' } }`,
      ),
    );
    rt.render(BAR_A);
    const [pinnedA, freeA] = [rt.bgOf("tag"), rt.bgOf("free")];
    rt.render(BAR_B);
    expect(rt.bgOf("tag")).toBe(pinnedA);
    expect(rt.bgOf("free")).not.toBe(freeA);
  });
});

describe("load errors", () => {
  const refusal = (src: string): string => {
    try {
      parseAndValidate("<test>", src, ALLOWED);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("config loaded");
  };

  test("a placement's theme outside the domain", () => {
    expect(
      refusal(
        configWith(
          "{ template: 'x' }",
          `{ seg: 'tag', settings: { theme: 'nope' } }`,
        ),
      ),
    ).toContain(
      `sets "theme" to "nope", but it must be "bar" (the bar's own theme) or an installed theme name`,
    );
  });

  test("an id or settings on the settings menu's anchor, which configures nothing", () => {
    expect(
      refusal(
        configWith(
          "{ template: 'x' }",
          `{ seg: 'candybar.menu', settings: { theme: '${PIN}' } }, 'tag'`,
        ),
      ),
    ).toContain(`place it as the bare name "candybar.menu"`);
  });

  test("a segment declaring `theme` itself", () => {
    expect(
      refusal(
        configWith(
          "{ template: 'x', settings: { theme: { label: 't', domain: 'bool', default: true } } }",
          "'tag'",
        ),
      ),
    ).toContain(`setting "theme" is one every placement already has`);
  });
});

describe("configure mode picks a placement's theme", () => {
  test("a carousel pick recolours that placement alone, its options paint in what they apply, and save writes it", () => {
    durable.write(TWO);
    const rt = buildRuntime(TWO);
    configurePlacement(rt.sessionState, SID, "default", "tag");
    const key = placementDraftKey("default", "tag", "theme");
    const out = rt.render(BAR_A);
    // Every cell of the carousel applies the option it names, gated by the
    // theme domain.
    const writing = (value: string): string[] =>
      linkUrls(out).filter((u) =>
        effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
      );
    const [first] = listResolvablePaletteNames();
    expect(writing(first!).length).toBeGreaterThan(0);
    const gate = stateGate(rt.config);
    expect(gate.validate(key, first!).ok).toBe(true);
    expect(gate.validate(key, FOLLOW_BAR).ok).toBe(true);
    expect(gate.validate(key, "nope").ok).toBe(false);
    // The option is painted on the ground of the theme it applies.
    const [r, g, b] = hex(paletteForThemeName(first!), "background")
      .slice(1)
      .match(/../g)!
      .map((h) => parseInt(h, 16));
    expect(out).toContain(`48;2;${r};${g};${b}`);

    const pinnedBefore = rt.bgOf("pinned");
    rt.click(writing(first!)[0]!);
    rt.sessionState.set(SID, EDIT_MODE_KEY, "closed");
    rt.render(BAR_A);
    const following = buildRuntime(
      configWith("{ template: 'x' }", `'tag', { seg: 'tag', id: 'pinned' }`),
    );
    following.render(first!);
    expect(rt.bgOf("tag")).toBe(following.bgOf("tag"));
    expect(rt.bgOf("pinned")).toBe(pinnedBefore);

    const logged: string[] = [];
    VERBS.get(VERB_SAVE)!(SID, {
      ...rt.ctx,
      dlog: (_level, message) => logged.push(message),
    });
    // The save's one event names the theme it wrote.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`default/tag.settings.theme=${first}`);
    expect(rt.sessionState.get(SID, key)).toBeNull();
    expect(durable.text()).toContain(
      `{ seg: "tag", settings: { theme: "${first}" } }`,
    );
  });
});

describe("configure mode over a placement several presets share", () => {
  // The label is declared once for every preset holding the placement, so
  // what is per preset — the configure member it shows under — must not live
  // on that one declaration, or the last preset synthesized wins it.
  test("configuring it in the floor preset shows its controls", () => {
    const rt = buildRuntime(`{
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
      },
      segments: { tag: { template: 'x' } },
      root: { v: [{ h: ['tag'] }] },
      presets: { zzz: { root: { v: [{ h: ['tag'] }] } } },
    }`);
    configurePlacement(rt.sessionState, SID, "default", "tag");
    const key = placementDraftKey("default", "tag", "theme");
    const controls = linkUrls(rt.render(BAR_A)).filter((u) =>
      effectsOf(u).some((e) => e.args[1] === key),
    );
    expect(controls.length).toBeGreaterThan(0);
  });
});

describe("the layout preview while arranging", () => {
  // In the names view each placement's cell is held by its label, and the
  // preview draws the label as the placement it stands for — in that
  // placement's theme: its pin, and its unsaved pick.
  const previewPalette = (
    rt: ReturnType<typeof buildRuntime>,
    segment: string,
  ): Palette[] =>
    rt.compiled.menuRuntime.action
      .layout()
      .flat()
      .filter((b) => b.name === segment)
      .map((b) => b.palette);

  test("a pinned placement keeps its theme, and an unsaved pick shows", () => {
    const rt = buildRuntime(TWO);
    rt.sessionState.set(SID, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    rt.render(BAR_A);
    const drawn = previewPalette(rt, "tag");
    expect(drawn).toHaveLength(2);
    expect(drawn).toContain(paletteForThemeName(PIN));
    rt.sessionState.set(SID, placementDraftKey("default", "tag", "theme"), BAR_B);
    rt.render(BAR_A);
    expect(previewPalette(rt, "tag")).toEqual([
      paletteForThemeName(BAR_B),
      paletteForThemeName(PIN),
    ]);
  });
});
