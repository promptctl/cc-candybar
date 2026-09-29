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
import { resolveEffectiveGlobals } from "../src/daemon/render-payload";
import { sharedMenuStateKey } from "../src/config/menu-keys";

const SID = "test0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b";
const PICKERS = sharedMenuStateKey("settings.pickers");
const plain = (s: string): string =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");

const door = { "settings.menu": "open" };
const config = { ...door, "settings.config": "open" };
const ring = (name: string, base: Record<string, string>) => ({
  ...base,
  [PICKERS]: `settings.apply.${name}`,
});
const STATES: Record<string, Record<string, string>> = {
  closed: {},
  door,
  config,
  tools: { ...door, "settings.tools": "open" },
  presetRing: ring("preset", door),
  themeRing: ring("theme", config),
  lookRing: ring("look", config),
  styleRing: ring("style", config),
  progressionRing: ring("progression", config),
  charsetRing: ring("charset", config),
  depthRing: ring("colorCompatibility", config),
  edit: { "edit.mode": "open" },
};

function renderToday(preset: string, width: number, state: Record<string, string>): string {
  const { config: merged, source } = loadConfig(null, DEFAULT_DSL_CONFIG);
  const cfg = validateConfig(merged, "<default>", source);
  const session = new SessionState();
  session.set(SID, "preset", preset);
  for (const [k, v] of Object.entries(state)) session.set(SID, k, v);
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, session);
  const compiled = registerDslConfig(cfg, registry, { cwd: "/home/tester/code/cc-candybar/src" });
  const eff = resolveEffectiveGlobals(cfg, (k) => session.get(SID, k) ?? null, () => false);
  const payload = { ...checkPayload(eff), term: { cols: width } };
  return renderDsl(
    cfg, compiled, store, registry, payload,
    { style: eff.style, separator: eff.separator, width, colorCompatibility: eff.colorCompatibility,
      wrap: eff.autoWrap, padding: eff.padding, charset: eff.charset },
    { onSegmentError: (s, m) => console.log(`ERROR ${s}: ${m}`) },
    { theme: eff.theme, look: eff.look, preset: eff.preset, progression: eff.progression },
  );
}

console.log("# Part 1 — today, rendered");
for (const preset of ["default", "compact"]) {
  for (const width of [80, 200]) {
    for (const [name, state] of Object.entries(STATES)) {
      console.log(`--- ${preset} ${name} @${width}`);
      for (const line of plain(renderToday(preset, width, state)).split("\n")) {
        console.log(`[${cellLen(line)}] ${line}`);
      }
    }
  }
}

const model = (cells: readonly string[]): number =>
  cells.reduce((w, c) => w + cellLen(c) + 3, 1);
const PROPOSED: Record<string, readonly string[]> = {
  "today door row (validates model)": ["❌", "⎘ id ↗ proj ↗ log ↗ repo", "☐ persist?", "(?)", "▦ default ▸ ↺", "⚙ config ▸", "🧰 tools ▸", "✎ edit"],
  "today config row (validates model)": ["✕", "🎨 tokyo-night ▸ ↺", "◐ none ▸ ↺", "✦ powerline ▸ ↺", "🎼 secondary-accent ▸ ↺", "🔣 unicode ▸ ↺", "🌈 truecolor ▸ ↺", "wrap: on ↺", "◀ padding 1 ▶ ↺"],
  "door line 1": ["❌", "▦ default ▸"],
  "door line 1 + save cell": ["❌", "▦ default ▸", "💾 save 3 ↶ ↷ ⟲"],
  "door line 1 + reset confirm": ["❌", "▦ default ▸", "💾 save 3 ↶ ↷ ⟲ reset all?"],
  "door line 2: tabs": ["✕", "⚡ session", "🎨 look", "📐 layout", "⚙ config", "🧰 tools"],
  "door line 2: tabs, two marked": ["✕", "⚡ session", "🎨 look •", "📐 layout •", "⚙ config", "🧰 tools"],
  "session links": ["✕", "⎘ id ⎘ resume ↗ proj ↗ log ↗ repo ↗ config"],
  "session commands": ["✕", "/compact", "/clear", "/model", "⏲ autocompact ▸"],
  "look": ["✕", "◀ tokyo-night ▶", "◀ none ▶", "◀ accent ▶", "◀ powerline ▶"],
  "look, long names": ["✕", "◀ catppuccin-frappe ▶", "◀ inverted ▶", "◀ accent ▶", "◀ powerline ▶"],
  "look, drifted": ["✕", "◀ catppuccin-frappe ▶ ↺", "◀ inverted ▶ ↺", "◀ mono ▶ ↺", "◀ capsule ▶ ↺"],
  "layout": ["✕", "+ preset", "✎ arrange", "wrap: on", "◀ padding 1 ▶"],
  "tools": ["✕", "🩺 doctor"],
  "edit row": ["✓ save 2", "↩ cancel", "↺ reset layout"],
};
console.log("\n# Part 2 — proposed, modelled at padding 1");
for (const [name, cells] of Object.entries(PROPOSED)) {
  console.log(`${model(cells)}\t+${2 * cells.length}/padding step\t${name}`);
}
