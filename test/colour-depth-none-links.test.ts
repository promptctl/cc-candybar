// brandon-colour-depth-64q — colour depth governs colour, never the controls.
//
// [LAW:verifiable-goals] Pick `none` from the bar's own colour-depth ring and
// the bar draws no SGR yet keeps every link it has drawn in colour — including
// the ring's way back, which a click on the colourless bar then takes.

import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { SETTINGS } from "../src/config/setting-projections";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import { VERB_SET_STATE } from "../src/click/wire";
import { SessionState } from "../src/daemon/session-state";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import {
  effectiveInputs,
  resolveEffectiveGlobals,
} from "../src/daemon/render-payload";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import {
  listResolvablePaletteNames,
  type ColorCompatibility,
} from "../src/themes/policy";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { clickUrl, effectsOf, testVerbContext } from "./helpers/click";
import { linkUrls, stripAnsi } from "./helpers/ansi";

const SGR = /\x1b\[[0-9;]*m/g;
const DEPTH_KEY = SETTINGS.colorCompatibility.sessionKey;

test("picking colour depth none keeps every link, and the colourless bar picks its way back", () => {
  const config = parseAndValidate(
    "<test>",
    "{}",
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  try {
    const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
    const ctx = testVerbContext(sessionState);
    // [LAW:one-source-of-truth] The daemon's own resolution: session picks fold
    // into the effective globals, which feed both the payload's `.effective`
    // read-backs and the depth the bytes are drawn at. `drawnAt` overrides only
    // the latter, to draw one state at two depths.
    const effective = () =>
      resolveEffectiveGlobals(
        config,
        (key) => sessionState.get("s1", key),
        () => false,
      );
    const effectiveDepth = (): ColorCompatibility =>
      effective().colorCompatibility;
    const render = (drawnAt: ColorCompatibility = effectiveDepth()): string =>
      renderDsl(
        config,
        compiled,
        store,
        registry,
        {
          session_id: "s1",
          cwd: "/tmp/proj",
          workspace: {
            current_dir: "/tmp/proj",
            project_dir: "/tmp/proj",
            added_dirs: [],
          },
          model: { id: "claude-opus-4-7", display_name: "Opus" },
          ...effectiveInputs(effective()),
        },
        {
          endcaps: "powerline",
          wrap: true,
          padding: 1,
          charset: "unicode",
          width: 200,
          colorCompatibility: drawnAt,
        },
      );
    // The links on `rendered` that write `key` a value `member` accepts.
    const writers = (
      rendered: string,
      key: string,
      member: (v: string) => boolean,
    ): string[] =>
      linkUrls(rendered).filter((url) =>
        effectsOf(url).some(
          (e) =>
            e.verb === VERB_SET_STATE &&
            e.args[1] === key &&
            member(e.args[2] ?? ""),
        ),
      );
    const click = (
      rendered: string,
      key: string,
      member: (v: string) => boolean,
    ): void => {
      const [url] = writers(rendered, key, member);
      if (url === undefined)
        throw new Error(`nothing on the bar writes ${key}`);
      clickUrl(url, ctx);
    };
    // Open the 🍫 door, ⚙ config, then the 🌈 colour depth ring — the clicks a user makes.
    const opened = (v: string) => v !== DISCLOSURE_CLOSED;
    click(render(), SETTINGS_ANCHOR, opened);
    click(render(), "candybar.tab", (v) => v === "config");
    click(render(), "menus.candybar_pickers", (v) =>
      v.endsWith("colorCompatibility"),
    );

    click(render(), DEPTH_KEY, (v) => v === "none");
    expect(effectiveDepth()).toBe("none");
    const none = render();
    expect(none.match(SGR)).toBeNull();
    // With no colour, the open tab is still marked: it alone leads with ▾.
    expect(stripAnsi(none)).toContain("▾ ⚙ config");
    expect(stripAnsi(none).match(/▾ (⚡ session|🎨 look|📐 layout|🧰 tools)/)).toBeNull();
    // The same state drawn in colour carries exactly the same links.
    expect(linkUrls(none)).toEqual(linkUrls(render("truecolor")));

    // The way back, taken from the colourless bar itself.
    click(none, DEPTH_KEY, (v) => v !== "none");
    expect(effectiveDepth()).not.toBe("none");
    expect(render().match(SGR)).not.toBeNull();
  } finally {
    disposers.forEach((d) => d());
    registry.dispose();
  }
});
