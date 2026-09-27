// brandon-colour-depth-64q — colour depth governs colour, never the controls.
//
// [LAW:verifiable-goals] At `colorCompatibility: "none"` the bar draws no SGR
// and keeps every link it has at truecolor — including the colour-depth ring
// that sets it back, so the setting cannot remove its own way out.

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
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import { listResolvablePaletteNames, type ColorCompatibility } from "../src/themes/policy";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { clickUrl, effectsOf, testVerbContext } from "./helpers/click";
import { linkUrls } from "./helpers/ansi";

const SGR = /\x1b\[[0-9;]*m/g;
const DEPTH_KEY = SETTINGS.colorCompatibility.sessionKey;

test("colour depth none draws no SGR and keeps every link the truecolor bar has", () => {
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
    const render = (colorCompatibility: ColorCompatibility): string =>
      renderDsl(
        config,
        compiled,
        store,
        registry,
        {
          session_id: "s1",
          cwd: "/tmp/proj",
          workspace: { current_dir: "/tmp/proj", project_dir: "/tmp/proj", added_dirs: [] },
          model: { id: "claude-opus-4-7", display_name: "Opus" },
        },
        {
          style: "powerline",
          wrap: true,
          padding: 1,
          charset: "unicode",
          width: 200,
          colorCompatibility,
        },
      );
    // The links on `rendered` that write `key` a value `member` accepts.
    const writers = (rendered: string, key: string, member: (v: string) => boolean): string[] =>
      linkUrls(rendered).filter((url) =>
        effectsOf(url).some(
          (e) => e.verb === VERB_SET_STATE && e.args[1] === key && member(e.args[2] ?? ""),
        ),
      );
    // Open the 🍫 door, ⚙ config, then the 🌈 colour depth ring — the clicks a user makes.
    const opened = (v: string) => v !== DISCLOSURE_CLOSED;
    for (const [key, member] of [
      [SETTINGS_ANCHOR, opened],
      ["settings.config", opened],
      ["menus.settings_pickers", (v: string) => v.endsWith("colorCompatibility")],
    ] as const) {
      const [url] = writers(render("truecolor"), key, member);
      if (url === undefined) throw new Error(`nothing on the bar opens ${key}`);
      clickUrl(url, ctx);
    }

    const truecolor = render("truecolor");
    const none = render("none");
    // Non-vacuous: the ring over every colour depth is on the truecolor bar.
    expect(writers(truecolor, DEPTH_KEY, (v) => v === "none")).not.toEqual([]);
    expect(linkUrls(none)).toEqual(linkUrls(truecolor));
    expect(none.match(SGR)).toBeNull();
    // The way back: the colourless bar still writes a depth other than none.
    expect(writers(none, DEPTH_KEY, (v) => v !== "none")).not.toEqual([]);
  } finally {
    disposers.forEach((d) => d());
    registry.dispose();
  }
});
