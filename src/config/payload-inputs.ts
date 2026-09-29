// [LAW:one-source-of-truth] The payload inputs the synthesized chrome reads —
// the settings menu's tray, controls and carousels, and edit chrome's
// customized banner — declared ONCE. The bundled default spreads this table
// into its variables; the synthesis passes ensure from it whatever their
// artifacts read that the config did not declare (brandon-settings-menu-d6f),
// so a config declaring nothing still gets a menu that renders, and a
// declaration here cannot drift from the one the default ships.
//
// [LAW:one-way-deps] It lives below both readers: default-dsl-config.ts
// imports the loader, and the loader runs the synthesis, so the synthesis
// cannot import the default without a cycle.

import type { VariableDecl } from "./dsl-types.js";
import { SESSION_ID_VAR_NAME } from "../var-system/sources.js";

// The width a compile-only caller (no render, so no width injected) fits and
// reads: `term.cols`'s default below and ActionRuntime.width's floor.
export const TERM_COLS_FLOOR = 80;

export const PAYLOAD_INPUTS: Readonly<Record<string, VariableDecl>> = {
  project_dir: {
    kind: "input",
    path: "workspace.project_dir",
    default: "",
  },
  [SESSION_ID_VAR_NAME]: { kind: "input", path: "session_id", default: "" },
  // Transcript path (a top-level hookData field, spread onto the payload
  // root by buildRenderPayload). Read by the quick-action tray's
  // openTranscript action — pass-through, no projection.
  transcript_path: {
    kind: "input",
    path: "transcript_path",
    default: "",
  },
  // [LAW:one-source-of-truth] The daemon-resolved effective theme name —
  // effectiveThemeName(sessionState.theme, globals.palette), the SAME name the
  // rendered basePalette is built from. A theme-picker config's trigger reads
  // `{{ .theme.effective }}` to show the active theme, so the label and the
  // colors trace to one resolution and cannot drift — no per-config restating
  // of the initial theme (which JSON5, being inert data, cannot derive). The
  // daemon always provides it; the "" default is the unreachable-absence floor.
  "theme.effective": {
    kind: "input",
    path: "theme.effective",
    default: "",
  },
  // [LAW:one-type-per-behavior] The effective LOOK name, the exact twin of
  // theme.effective one dimension over — effectiveLookName(sessionState.look,
  // globals.look, looks), the SAME name whose ThemeKey adapts the rendered
  // palette. A look-picker trigger reads `{{ .look.effective }}` for its
  // label; the label and the colors trace to one resolution.
  "look.effective": {
    kind: "input",
    path: "look.effective",
    default: "",
  },
  // [LAW:one-type-per-behavior] The effective PRESET name, theme/look's twin
  // one level up — effectivePresetName(sessionState.preset, globals.preset,
  // presets), the SAME name that selected the layout this render walked and
  // the globals it rendered with. A preset-picker trigger reads
  // `{{ .preset.effective }}` for its label, so the label and the arrangement
  // trace to one resolution.
  "preset.effective": {
    kind: "input",
    path: "preset.effective",
    default: "",
  },
  // [LAW:one-source-of-truth] brandon-layout-edit-2gc.5 — does the config
  // file author the active preset's root, resolved alongside preset.effective
  // (RenderPayload.preset.customized). edit-chrome.ts's synthesized "↺ …
  // customized" segment gates on this directly; a hand-authored config can
  // read it too for its own reset affordance.
  "preset.customized": {
    kind: "input",
    path: "preset.customized",
    type: "boolean",
    default: false,
  },
  // Does the bundled default declare the active preset (RenderPayload
  // .preset.bundled) — false for a preset the user authored, which the
  // settings menu offers to delete.
  "preset.bundled": {
    kind: "input",
    path: "preset.bundled",
    type: "boolean",
    default: true,
  },
  // [LAW:one-type-per-behavior] style/charset/colorCompatibility/autoWrap/
  // padding are theme/look's twins over the remaining persistable globals
  // (candybar-config-engine-71o.3) — the SAME values BuildLineOptions
  // renders with, each read back through this projection so a `persist`
  // action over the field shows a "current selection" highlight and a
  // trigger label can display the active value without restating it.
  "style.effective": {
    kind: "input",
    path: "style.effective",
    default: "",
  },
  "progression.effective": {
    kind: "input",
    path: "progression.effective",
    default: "",
  },
  "charset.effective": {
    kind: "input",
    path: "charset.effective",
    default: "",
  },
  "colorCompatibility.effective": {
    kind: "input",
    path: "colorCompatibility.effective",
    default: "",
  },
  "autoWrap.effective": {
    kind: "input",
    path: "autoWrap.effective",
    type: "boolean",
    default: true,
  },
  "padding.effective": {
    kind: "input",
    path: "padding.effective",
    type: "number",
    default: 1,
  },

  // [LAW:one-source-of-truth] The usable terminal width for THIS render —
  // the exact post-reserve cell count FlexStrip wraps to. renderDsl injects
  // it into the payload from its own `opts.width`, the value a row fits to
  // (ActionRuntime.width) and the strip wraps to, so a template reading it
  // and the wrap algebra can never disagree. Never cached: a resize is just a
  // new value on the same path, re-read every render. The default only
  // applies to compile-only callers that render without injecting a width.
  "term.cols": {
    kind: "input",
    path: "term.cols",
    type: "number",
    default: TERM_COLS_FLOOR,
  },

  // The repo's browsable web page, transposed from its remote by the daemon.
  // "" is the genuine "no remote a browser can open" (local-only repo, bare
  // path remote) — the quick-action tray's link reads that value, not a flag.
  "git.repoUrl": { kind: "input", path: "git.repoUrl", default: "" },
};
