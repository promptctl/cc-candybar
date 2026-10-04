// Reproduces every width in SETTINGS-MENU-MAP.md.
//   pnpm exec tsx design-docs/settings-menu-map-render.mts
// Part 1 renders TODAY's menu through renderDsl (the check payload, one session
// state per open disclosure) at 80 and 200 columns in the default and compact
// presets. Part 2 measures the PROPOSED rows with the model part 1 validates:
// each cell is its text + 2 padding + 1 seam, plus one cap per row, at padding 1.
import { cellLen } from "@promptctl/rich-js";
import { loadConfig, validateConfig } from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { checkPayload } from "../src/check";
import {
  renderOptionsOf,
  renderSelectionOf,
  resolveEffectiveGlobals,
} from "../src/daemon/render-payload";
import { sharedMenuStateKey } from "../src/config/menu-keys";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";
import { EDIT_MODE_ARRANGE, EDIT_MODE_KEY } from "../src/config/loader/edit-mode";
import { stripAnsi } from "../test/helpers/ansi";
import { perSetting } from "../src/config/setting-projections";

const SID = "test0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b";
const PICKERS = sharedMenuStateKey(`${SETTINGS_NS}pickers`);
const door = { [SETTINGS_ANCHOR]: SETTINGS_OPEN };
const TAB = `${SETTINGS_NS}tab`;
const tab = (name: string) => ({ ...door, [TAB]: name });
const look = tab("look");
const config = tab("config");
const ring = (name: string, base: Record<string, string>) => ({
  ...base,
  [PICKERS]: `${SETTINGS_NS}apply.${name}`,
});
const STATES: Record<string, Record<string, string>> = {
  closed: {},
  door,
  look,
  layout: tab("layout"),
  config,
  tools: tab("tools"),
  presetRing: ring("preset", door),
  themeRing: ring("theme", look),
  styleRing: ring("style", look),
  endcapsRing: ring("endcaps", look),
  variationRing: ring("variation", look),
  charsetRing: ring("charset", config),
  depthRing: ring("colorCompatibility", config),
  edit: { [EDIT_MODE_KEY]: EDIT_MODE_ARRANGE },
};

// checkPayload marks every setting resettable so every ↺ renders; a fresh
// session, with nothing to reset, is the same payload with none marked.
type Drift = "all marked" | "fresh";
function renderToday(
  preset: string, width: number, state: Record<string, string>, drift: Drift = "all marked",
): string {
  const cfg = validateConfig(loadConfig(null, DEFAULT_DSL_CONFIG), "<default>");
  const session = new SessionState();
  session.set(SID, "preset", preset);
  for (const [k, v] of Object.entries(state)) session.set(SID, k, v);
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, session);
  const compiled = registerDslConfig(cfg, registry, { cwd: "/home/tester/code/cc-candybar/src" });
  const eff = resolveEffectiveGlobals(cfg, (k) => session.get(SID, k) ?? null, () => false);
  const payload = {
    ...checkPayload(eff, null),
    ...(drift === "fresh" ? { resettable: perSetting(() => false) } : {}),
    session_id: SID,
    term: { cols: width },
  };
  return renderDsl(
    cfg, compiled, store, registry, payload, renderOptionsOf(eff, width),
    { onSegmentError: (s, m) => console.log(`ERROR ${s}: ${m}`) },
    renderSelectionOf(eff),
  );
}

const rendered = new Map<string, string[]>();
console.log("# Part 1 — today, rendered");
for (const preset of ["default", "compact"]) {
  for (const width of [80, 200]) {
    for (const [name, state] of Object.entries(STATES)) {
      console.log(`--- ${preset} ${name} @${width}`);
      const lines = stripAnsi(renderToday(preset, width, state)).split("\n");
      for (const line of lines) console.log(`[${cellLen(line)}] ${line}`);
      rendered.set(`${preset} ${name} @${width}`, lines);
    }
    console.log(`--- ${preset} fresh door @${width}`);
    const lines = stripAnsi(renderToday(preset, width, door, "fresh")).split("\n");
    for (const line of lines) console.log(`[${cellLen(line)}] ${line}`);
    rendered.set(`${preset} fresh door @${width}`, lines);
  }
}

const model = (cells: readonly string[]): number =>
  cells.reduce((w, c) => w + cellLen(c) + 3, 1);
const PROPOSED: Record<string, readonly string[]> = {
  "today look tab (validates model)": ["✕", "🎨 tokyo-night ▸ ↺", "◐ none ▸ ↺", "✦ powerline ▸ ↺", "🎼 accent ▸ ↺"],
  "today layout tab (validates model)": ["✕", "+ preset", "✎ arrange", "☑ wrap ↺", "◀ padding 1 ▶ ↺"],
  "door line 1": ["✕", "▦ default ▸"],
  "door line 1 + save cell": ["✕", "▦ default ▸", "💾 save 3 ↶ ↷ ⟲"],
  "door line 1 + reset confirm": ["✕", "▦ default ▸", "💾 save 3 ↶ ↷ ⟲ reset all?"],
  "door line 2: tabs": ["✕", "▾ ⚡ session", "🎨 look", "📐 layout", "⚙ config", "🧰 tools"],
  "door line 2: tabs, two marked": ["✕", "▾ ⚡ session", "🎨 look •", "📐 layout •", "⚙ config", "🧰 tools"],
  // checkPayload marks every setting resettable, so every tab holding a control is marked.
  "today tabs, all marked (validates model)": ["✕", "▾ ⚡ session", "🎨 look •", "📐 layout •", "⚙ config •", "🧰 tools"],
  "session links": ["✕", "⎘ id ⎘ resume ↗ proj ↗ log ↗ repo ↗ config"],
  "session commands": ["✕", "/compact", "/clear", "/model", "⏲ autocompact ▸"],
  "look": ["✕", "◀ tokyo-night ▶", "◀ none ▶", "◀ accent ▶", "◀ powerline ▶"],
  "look, long names": ["✕", "◀ catppuccin-frappe ▶", "◀ inverted ▶", "◀ accent ▶", "◀ powerline ▶"],
  "look, drifted": ["✕", "◀ catppuccin-frappe ▶ ↺", "◀ inverted ▶ ↺", "◀ mono ▶ ↺", "◀ capsule ▶ ↺"],
  "layout": ["✕", "+ preset", "✎ arrange", "wrap: on", "◀ padding 1 ▶"],
  "tools": ["✕", "🩺 doctor"],
  "edit row": ["✓ save", "↩ cancel", "↺ reset layout", "☐ live"],
};
console.log("\n# Part 2 — proposed, modelled at padding 1");
for (const [name, cells] of Object.entries(PROPOSED)) {
  console.log(`${model(cells)}\t+${2 * cells.length}/padding step\t${name}`);
}

// The model is only as good as its fit to today's render: each validating row
// must equal the line Part 1 rendered for that state that holds its marker, or
// the script fails.
const VALIDATES: Record<string, [state: string, marker: string]> = {
  "door line 2: tabs": ["default fresh door @200", "⚡ session"],
  "today tabs, all marked (validates model)": ["default door @200", "⚡ session"],
  "tools": ["default tools @200", "🩺 doctor"],
  "today look tab (validates model)": ["default look @200", "◐ none"],
  "today layout tab (validates model)": ["default layout @200", "✎ arrange"],
};
for (const [row, [state, marker]] of Object.entries(VALIDATES)) {
  const modelled = model(PROPOSED[row]);
  const line = rendered.get(state)?.find((l) => l.includes(marker));
  const width = line === undefined ? undefined : cellLen(line);
  if (modelled !== width) {
    throw new Error(`model drift: ${row} = ${modelled}, ${state} rendered ${width}`);
  }
}
