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

const SID = "test0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b";
const PICKERS = sharedMenuStateKey(`${SETTINGS_NS}pickers`);
const door = { [SETTINGS_ANCHOR]: SETTINGS_OPEN };
const config = { ...door, [`${SETTINGS_NS}config`]: SETTINGS_OPEN };
const ring = (name: string, base: Record<string, string>) => ({
  ...base,
  [PICKERS]: `${SETTINGS_NS}apply.${name}`,
});
const STATES: Record<string, Record<string, string>> = {
  closed: {},
  door,
  config,
  tools: { ...door, [`${SETTINGS_NS}tools`]: SETTINGS_OPEN },
  presetRing: ring("preset", door),
  themeRing: ring("theme", config),
  lookRing: ring("look", config),
  styleRing: ring("style", config),
  progressionRing: ring("progression", config),
  charsetRing: ring("charset", config),
  depthRing: ring("colorCompatibility", config),
  edit: { [EDIT_MODE_KEY]: EDIT_MODE_ARRANGE },
};

function renderToday(preset: string, width: number, state: Record<string, string>): string {
  const cfg = validateConfig(loadConfig(null, DEFAULT_DSL_CONFIG), "<default>");
  const session = new SessionState();
  session.set(SID, "preset", preset);
  for (const [k, v] of Object.entries(state)) session.set(SID, k, v);
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, session);
  const compiled = registerDslConfig(cfg, registry, { cwd: "/home/tester/code/cc-candybar/src" });
  const eff = resolveEffectiveGlobals(cfg, (k) => session.get(SID, k) ?? null, () => false);
  const payload = { ...checkPayload(eff), session_id: SID, term: { cols: width } };
  return renderDsl(
    cfg, compiled, store, registry, payload, renderOptionsOf(eff, width),
    { onSegmentError: (s, m) => console.log(`ERROR ${s}: ${m}`) },
    renderSelectionOf(eff),
  );
}

const widest = new Map<string, number>();
console.log("# Part 1 — today, rendered");
for (const preset of ["default", "compact"]) {
  for (const width of [80, 200]) {
    for (const [name, state] of Object.entries(STATES)) {
      console.log(`--- ${preset} ${name} @${width}`);
      const lines = stripAnsi(renderToday(preset, width, state)).split("\n");
      for (const line of lines) console.log(`[${cellLen(line)}] ${line}`);
      widest.set(`${preset} ${name} @${width}`, Math.max(...lines.map((l) => cellLen(l))));
    }
  }
}

const model = (cells: readonly string[]): number =>
  cells.reduce((w, c) => w + cellLen(c) + 3, 1);
const PROPOSED: Record<string, readonly string[]> = {
  "today door row (validates model)": ["❌", "⎘ id ↗ proj ↗ log ↗ repo", "/compact /model /clear", "▦ default ▸ ↺", "💾 save 1", "⚙ config ▸", "🧰 tools ▸", "✎ edit", "↶ undo", "↷ redo"],
  "today config row (validates model)": ["✕", "🎨 tokyo-night ▸ ↺", "◐ none ▸ ↺", "✦ powerline ▸ ↺", "🎼 secondary-accent ▸ ↺", "🔣 unicode ▸ ↺", "🌈 truecolor ▸ ↺", "☑ wrap ↺", "◀ padding 1 ▶ ↺", "☑ update notice ↺", "⟲ reset all"],
  "door line 1": ["✕", "▦ default ▸"],
  "door line 1 + save cell": ["✕", "▦ default ▸", "💾 save 3 ↶ ↷ ⟲"],
  "door line 1 + reset confirm": ["✕", "▦ default ▸", "💾 save 3 ↶ ↷ ⟲ reset all?"],
  "door line 2: tabs": ["✕", "⚡ session", "🎨 look", "📐 layout", "⚙ config", "🧰 tools"],
  "door line 2: tabs, two marked": ["✕", "⚡ session", "🎨 look •", "📐 layout •", "⚙ config", "🧰 tools"],
  "session links": ["✕", "⎘ id ⎘ resume ↗ proj ↗ log ↗ repo ↗ config"],
  "session commands": ["✕", "/compact", "/clear", "/model", "⏲ autocompact ▸"],
  "look": ["✕", "◀ tokyo-night ▶", "◀ none ▶", "◀ accent ▶", "◀ powerline ▶"],
  "look, long names": ["✕", "◀ catppuccin-frappe ▶", "◀ inverted ▶", "◀ accent ▶", "◀ powerline ▶"],
  "look, drifted": ["✕", "◀ catppuccin-frappe ▶ ↺", "◀ inverted ▶ ↺", "◀ mono ▶ ↺", "◀ capsule ▶ ↺"],
  "layout": ["✕", "+ preset", "✎ arrange", "wrap: on", "◀ padding 1 ▶"],
  "tools": ["✕", "🩺 doctor"],
  "edit row": ["✓ save 2", "↩ cancel", "↺ reset layout", "☐ live"],
};
console.log("\n# Part 2 — proposed, modelled at padding 1");
for (const [name, cells] of Object.entries(PROPOSED)) {
  console.log(`${model(cells)}\t+${2 * cells.length}/padding step\t${name}`);
}

// The model is only as good as its fit to today's render: each validating row
// must equal the widest line Part 1 rendered for that state, or the script fails.
const VALIDATES: Record<string, string> = {
  "today door row (validates model)": "default door @200",
  "today config row (validates model)": "default config @200",
};
for (const [row, rendered] of Object.entries(VALIDATES)) {
  const modelled = model(PROPOSED[row]);
  if (modelled !== widest.get(rendered)) {
    throw new Error(`model drift: ${row} = ${modelled}, ${rendered} rendered ${widest.get(rendered)}`);
  }
}
