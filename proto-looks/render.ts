// The bundled bar under every bundled theme, closed and with its menus open, for
// every variation, shade and payload named on the command line — rendered
// through the bar's own path (registerDslConfig + resolveEffectiveGlobals +
// renderDsl, as test/settings-menu-seams.test.ts drives it) under session picks
// of the variation and shade, exactly as a click would make them. One process:
// every variant is a value the tables name, so nothing here reaches into the
// colour model. Writes one JSON file. Harness for brandon-menus-sjhy.4fi.
//
//   node --require ./scripts/version-stamp.cjs --import tsx proto-looks/render.ts \
//     --out proto-looks/out/new.json --variations ends-primary,door-primary --shades middle,wide
import fs from "node:fs";
import { listThemePalettes } from "@promptctl/rich-js";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { sharedMenuStateKey } from "../src/config/menu-keys";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";
import { perSetting } from "../src/config/setting-projections";
import { CHECK_TODAY, checkPayload } from "../src/check";
import { renderOptionsOf } from "../src/daemon/render-payload";
import { SessionState } from "../src/daemon/session-state";
import { registerDslConfig, renderDsl, type RenderWarning } from "../src/dsl/render";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { paletteForThemeName } from "../src/themes/palette-resolvers";
import { instantOf } from "../src/utils/instant";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { parseAndValidate } from "../test/helpers/parse-and-validate";
import { TEST_SIGNER } from "../test/helpers/link-signer";

// [LAW:parse-dont-validate] The command line, read once into the three lists
// and the output path; an option missing or unknown stops the run here.
function args(): { out: string; variations: string[]; shades: string[] } {
  const given = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!["--out", "--variations", "--shades"].includes(flag ?? "") || value === undefined)
      throw new Error(`usage: render.ts --out <file> --variations a,b --shades x,y (got ${JSON.stringify(argv)})`);
    given.set(flag!, value);
  }
  const need = (flag: string): string => {
    const value = given.get(flag);
    if (value === undefined) throw new Error(`render.ts: ${flag} is required`);
    return value;
  };
  return { out: need("--out"), variations: need("--variations").split(","), shades: need("--shades").split(",") };
}

const SID = "looks0a1-2c3d-4e5f-8a7b-8c9d0e1f2a3b";
const COLS = 170;
const STATES = ["calm", "working", "hot"] as const;
type State = (typeof STATES)[number];

// What each payload shows over the decoration being judged. `hot` is check's
// own payload: every threshold and alert role painted over its cell. `calm`
// paints none. `working` is calm with the activity cell drawn — the last cell
// of the bundled status row, which a keystone on a line's end lands on.
const SHOWN: Record<State, (base: Record<string, unknown>) => Record<string, unknown>> = {
  hot: (base) => base,
  calm: (base) => ({
    ...base,
    context: { ...(base.context as object), contextLeft: 62 },
    block: { ...(base.block as object), nativeUtilization: 18 },
    host: { ...(base.host as object), ssh: false },
  }),
  working: (base) => ({
    ...SHOWN.calm(base),
    activity: { tool: { running: "Bash:2", done: "Read:5" } },
  }),
};

interface Rendered {
  readonly text: string;
  readonly warnings: readonly string[];
}

const { out, variations, shades } = args();
const config = parseAndValidate(
  "<user>",
  `{}`,
  new Set(listResolvablePaletteNames()),
  DEFAULT_DSL_CONFIG,
);
const session = new SessionState();
const store = new VariableStore();
const registry = new SourceRegistry(store, "", session);
const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/home/tester/code/project" });
const at = instantOf(new Date("2026-10-23T12:00:00Z"));

const render = (state: State): Rendered => {
  const effective = resolveEffectiveGlobals(config, (key) => session.get(SID, key) ?? null, () => false);
  const payload = {
    ...SHOWN[state]({ ...checkPayload(config, effective, null, at), today: CHECK_TODAY } as unknown as Record<string, unknown>),
    resettable: perSetting(() => false),
    unsaved: 0,
    history: { undo: 0, redo: 0 },
    session_id: SID,
    term: { cols: COLS },
  };
  const warnings: RenderWarning[] = [];
  const text = renderDsl(config, compiled, store, registry, payload, at, renderOptionsOf(effective, COLS), {
    // [LAW:no-silent-failure] A ⚠ cell would be drawn into the comparison as if it were the look.
    onSegmentError: (name, message) => {
      throw new Error(`${name}: ${message}`);
    },
    onRenderWarning: (warning) => warnings.push(warning),
  }, effective);
  // Only a band's floor is a fact about the look; any other warning is a fault in the harness.
  const faults = warnings.filter((w) => w.kind !== "band-floor");
  if (faults.length > 0) throw new Error(`render warned: ${faults.map((w) => w.message).join("; ")}`);
  return { text, warnings: [...new Set(warnings.map((w) => w.message))] };
};

const renders: Record<string, { closed: Rendered; open: Rendered }> = {};
const poles: Record<string, { background: string; foreground: string }> = {};
for (const theme of listThemePalettes()) {
  const palette = paletteForThemeName(theme);
  const hex = (role: string): string => {
    const colour = palette.get(role);
    if (colour === undefined) throw new Error(`${theme} names no ${role}`);
    return colour.hex;
  };
  poles[theme] = { background: hex("background"), foreground: hex("foreground") };
  session.set(SID, "theme", theme);
  for (const variation of variations) {
    for (const shade of shades) {
      for (const state of STATES) {
        session.set(SID, "variation", variation);
        session.set(SID, "shade", shade);
        session.set(SID, SETTINGS_ANCHOR, "closed");
        const closed = render(state);
        // The door open on ⚡ session, the theme's ⚙ open, and the style list
        // under it: bands at depths 0, 1 and 2.
        session.set(SID, SETTINGS_ANCHOR, SETTINGS_OPEN);
        session.set(SID, `${SETTINGS_NS}tab`, "session");
        session.set(SID, sharedMenuStateKey("candybar.pickers"), "gear");
        session.set(SID, sharedMenuStateKey("candybar.gearPickers"), "candybar.apply.style");
        const open = render(state);
        renders[`${variation}|${shade}|${state}|${theme}`] = { closed, open };
      }
    }
  }
}
registry.dispose();
fs.mkdirSync(out.slice(0, out.lastIndexOf("/")), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ poles, renders }));
console.log(`${out}: ${Object.keys(renders).length} renders`);
