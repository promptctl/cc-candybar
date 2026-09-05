// [LAW:one-source-of-truth] The bundled default DslConfig — the statusline
// rendered when no `.cc-candybar.json5` (or `.cc-candybar.json`) is present
// at any resolution layer. This is the canonical port of every built-in
// segment as a DSL declaration, covering the surface previously expressed
// by the legacy renderer that was retired in bzh.2.
//
// [LAW:single-enforcer] One default. User configs merge on top via
// `mergeWithDefault`: globals shallow-merge per field, variables/segments/
// helpers/actions/presets merge by name (user wins per name), and root's
// ROWS merge by name too (a `{ rows }` fragment restates only the rows it
// names; a whole tree replaces them). A user file only needs to declare what
// differs — overriding one segment, one variable, or one row takes a few
// lines. JSON5 supports
// inline comments so users can declare only the delta. The `.json` extension
// is also accepted (JSON ⊂ JSON5, same parser); `.json5` is preferred when
// both exist at the same location.
//
// [LAW:dataflow-not-control-flow] Every segment is declared regardless of
// whether the default `root` includes it — `root` is the tree that
// chooses what renders. Switching a disabled segment on is a root edit
// (add its name to the children), not new code. The same data flows through
// the same render path whether the root has 1 leaf or 16.
//
// [LAW:types-are-the-program] The authored literal (RAW_DEFAULT_DSL_CONFIG)
// uses `satisfies DslConfig` (not an annotation) so every declared segment
// and variable name is checked against the real shape at the point of
// authoring. The exported DEFAULT_DSL_CONFIG is that literal run through the
// loader's own synthesis pass (see the bottom of this file) — a `DslConfig`,
// the same effective shape every user config resolves to.

import type { DslConfig, LayoutNode, SegmentDecl } from "./dsl-types.js";
import { parseDslConfig } from "./dsl-loader.js";
// [LAW:one-source-of-truth] The bundled drawer's menus author their own
// disclosure glyphs now that `{{ menu }}` appends none. Interpolating the
// shared constants keeps the stdlib bar reading like every other disclosure
// without restating the vocabulary in three string literals.
import {
  DISCLOSURE_GLYPH_CLOSED,
  DISCLOSURE_GLYPH_OPEN,
} from "./disclosure.js";
import { mergeWithDefault } from "./loader/merge.js";

// ─── Shared template fragments ───────────────────────────────────────────────
//
// Factored out of the segments' `template` fields so:
//   (1) the git working-tree counts and status icon can be shared by the two
//       git-style segments (git, gitaculous) without duplication, and
//   (2) the block/weekly threshold cascade can be parameterized on the
//       variable name without resorting to runtime string surgery.

// Directory: ~ collapse under $HOME, project-relative under workspace.project_dir,
// else raw. Inline-recomputes the project-relative path because the DSL has no
// template-level `:=` (a `kind: "template"` var would express it once, but adds
// noise for a single use).
//
// Prefix checks are boundary-safe: a path is "under" a base iff it equals the
// base OR starts with `base + "/"`. The naive `hasPrefix base path` is a
// string match — it would treat `/home/alice` as a child of `/home/al`.
// `(printf "%s/" base)` adds the separator so the prefix can only land at a
// path boundary; the `eq` arm catches the exact-match case where the trailing
// slash would over-match.
//
// Equal-paths case (current_dir === project_dir) DOES enter the project-
// relative arm: DIR_REL evaluates to "" and the ternary picks basename
// (project_dir), so the project root renders as `<repo-name>` instead of the
// full absolute path. Same logic handles equal home & current_dir → just "~".
const DIR_REL = 'trimPrefix "/" (trimPrefix .project_dir .current_dir)';
// [LAW:decomposition] Two separable concerns: (1) COLLAPSE the absolute cwd to a
// short display form (`~`-relative, else project-relative, else absolute) and
// (2) ABBREVIATE fish-style. Collapse stays in the template (its inputs are the
// payload's home/project_dir/current_dir); abbreviation is a single helper
// applied to the collapsed result. `$dir` carries the collapsed path between the
// two — default is the absolute cwd, overridden only when it lives under home or
// the project root. brandon-directory-781 makes fish-abbreviation the DEFAULT;
// a user restores the full path by overriding `segments.directory.template`
// (drop the `abbreviatePath` wrapper) — the existing merge-by-name seam.
const DIR_TEMPLATE =
  "{{ $dir := .current_dir }}" +
  '{{ if and (ne .home "") (or (eq .home .current_dir) (hasPrefix (printf "%s/" .home) .current_dir)) }}' +
  `{{ $dir = printf "~%s" (trimPrefix .home .current_dir) }}` +
  "{{ else }}" +
  '{{ if or (eq .project_dir .current_dir) (hasPrefix (printf "%s/" .project_dir) .current_dir) }}' +
  `{{ $dir = ternary (${DIR_REL}) (basename .project_dir) (ne (${DIR_REL}) "") }}` +
  "{{ end }}{{ end }}" +
  "{{ abbreviatePath $dir }}";

// Git-fact → semantic palette color, ONE table both the `git` and
// `gitaculous` segment templates below read from. [LAW:one-source-of-truth]
// brandon-segments-3eo.1 (the recoloring itself) typed this choice
// independently into each template's literal string and the two drifted —
// gitaculous colored branch `accent` where git used `primary`, and left
// stash uncolored where git used `accent` — caught by live testing
// (brandon-segments-3eo.1.1). A shared table makes "what color is this
// fact" a value read twice, not a decision re-typed twice.
const GIT_COLOR = {
  branch: "primary",
  staged: "success",
  unstaged: "warning",
  untracked: "accent",
  conflicts: "error",
  ahead: "success",
  behind: "warning",
  stash: "accent",
} as const;

// Paint one git fact in its semantic color. The table above holds palette
// *variable names* (data), and this is the one place a name becomes a template
// call, so the fact→color decision and its spelling stay separate concerns.
// [LAW:one-source-of-truth]
//
// Note the shape: `fg (color "…")`, which is also what a composed color looks
// like — `fg (darken (color "…") 1)`. A template that wants to adjust one of
// these later wraps the color expression instead of rewriting the call.
const paint = (fact: keyof typeof GIT_COLOR, content: string): string =>
  `{{ fg (color "${GIT_COLOR[fact]}") ${content} }}`;

// How far the two git segments' *structural* text — labels, punctuation,
// brackets, the sha, the upstream name, the elapsed-time annotation — sits
// toward their own background, as a percentage. It is applied as the segments'
// `fg:`, so structural text is simply what a token renders as when the
// template does NOT paint it; only the operative facts (branch, counts,
// status) name a color. [LAW:dataflow-not-control-flow] — the quiet case is
// the default that always applies, not a wrapper each token opts into. That
// inversion is why these templates carry no de-emphasis markup at all.
//
// The blend target is the segment's OWN background (`bgOf`), not the theme's
// `background`. The git segments render on `surface-active`, so a palette
// `foreground-muted` — which blends toward `background` — would be muted
// toward a color that is not behind them, and would read either too loud or
// too faint depending on how far the surface sits from the base.
//
// The `readableOn` floor is what makes the result theme-independent, and it is
// not decoration: the bare 60% blend measures 1.93–3.10 contrast across the
// bundled themes (catppuccin-latte at 1.93 is genuinely hard to read), because
// a fixed *percentage* of a distance is not a fixed amount of legibility when
// themes disagree about how far apart their own foreground and surface sit.
// Flooring at WCAG's 3:1 large-text threshold lands every theme at 3.00–3.10
// against full-strength foregrounds of 5.8–10.9 — as quiet as each theme can
// afford, and never quieter. Verified across the bundled themes in
// test/default-dsl-config.test.ts rather than eyeballed on one.
// [LAW:verifiable-goals]
const GIT_QUIET_PCT = 60;
const GIT_QUIET_MIN_CONTRAST = 3;
const GIT_QUIET_FG =
  `{{ readableOn (mix (color "foreground") (bgOf) ${GIT_QUIET_PCT}) (bgOf) ` +
  `${GIT_QUIET_MIN_CONTRAST} }}`;

// Git working-tree counts — each present count renders in its own semantic
// palette color (GIT_COLOR above) so a dirty tree reads at a glance,
// p10k/gitaculous-prompt style, instead of one uniform segment fg. `$first`
// tracks whether a separator space is still owed before the next present
// count.
// [LAW:dataflow-not-control-flow]: one variable carries the "have we emitted
// yet" state rather than four copies of positional space logic. `$first` is
// declared inside the outer `{{ if or ... }}` gate (unlike DIR_TEMPLATE's
// `$dir`, declared at the template's top level) and reassigned via `=` in
// nested `{{ if }}` blocks below — Go template variable scoping walks up to
// the declaring frame on `=` regardless of nesting depth, so this still
// works, just at one more scope level than DIR_TEMPLATE's `$dir`. Verified
// by test/default-dsl-config.test.ts's "worktree counts render
// single-space-separated" test, not merely asserted here.
const GIT_WORKTREE =
  "{{ if or (gt .git.staged 0) (gt .git.unstaged 0) (gt .git.untracked 0) (gt .git.conflicts 0) }}" +
  ` ({{ $first := true }}` +
  `{{ if gt .git.staged 0 }}${paint("staged", '(printf "+%v" .git.staged)')}{{ $first = false }}{{ end }}` +
  `{{ if gt .git.unstaged 0 }}{{ if not $first }} {{ end }}${paint("unstaged", '(printf "~%v" .git.unstaged)')}{{ $first = false }}{{ end }}` +
  `{{ if gt .git.untracked 0 }}{{ if not $first }} {{ end }}${paint("untracked", '(printf "?%v" .git.untracked)')}{{ $first = false }}{{ end }}` +
  `{{ if gt .git.conflicts 0 }}{{ if not $first }} {{ end }}${paint("conflicts", '(printf "!%v" .git.conflicts)')}{{ $first = false }}{{ end }}` +
  "){{ end }}";

// Status icon precedence: conflicts → ⚠ (error), dirty → ● (warning), else
// clean ✓ (success) — colored to match the state it reports.
const GIT_STATUS =
  '{{ if eq .git.status "conflicts" }}{{ fg (color "error") "⚠" }}{{ else }}' +
  '{{ if eq .git.status "dirty" }}{{ fg (color "warning") "●" }}' +
  '{{ else }}{{ fg (color "success") "✓" }}{{ end }}{{ end }}';

// Every unpainted token here — the repo name, `⎇`, `♯`, the sha, the worktree
// parentheses, `→`, the upstream name — renders in the segment's quiet `fg:`
// (GIT_QUIET_FG). Only the operative facts name a color, so the template reads
// as the line it draws rather than as de-emphasis markup wrapped around it.
const GIT_TEMPLATE =
  '{{ if ne .git.repoName "" }}{{ .git.repoName }} {{ end }}' +
  `⎇ ${paint("branch", ".git.branch")}` +
  "{{ if .git.sha }} ♯ {{ .git.sha }}{{ end }}" +
  "{{ if or (gt .git.ahead 0) (gt .git.behind 0) }}" +
  ` {{ if gt .git.ahead 0 }}${paint("ahead", '(printf "↑%v" .git.ahead)')}{{ end }}` +
  `{{ if gt .git.behind 0 }}${paint("behind", '(printf "↓%v" .git.behind)')}{{ end }}{{ end }}` +
  GIT_WORKTREE +
  "{{ if .git.upstream }} →{{ .git.upstream }}{{ end }}" +
  `{{ if gt .git.stash 0 }} ${paint("stash", '(printf "⧇ %v" .git.stash)')}{{ end }}` +
  " " +
  GIT_STATUS;

// [LAW:dataflow-not-control-flow] block and weekly share the same threshold
// cascade (≥warningThreshold → error, ≥50 → warning, else panel) on a numeric
// ref. The builders parameterize BOTH the percentage ref and the threshold
// ref so each segment reads its own configured threshold from the var store
// rather than the literal 80 baked into the template. User overrides flow
// through the variables-merge-by-name cascade in mergeWithDefault — no new
// override mechanism required.
function blockLikeBg(pctRef: string, thresholdRef: string): string {
  return (
    `{{ if ge (round ${pctRef}) ${thresholdRef} }}error` +
    `{{ else }}{{ if ge (round ${pctRef}) 50 }}warning` +
    `{{ else }}panel{{ end }}{{ end }}`
  );
}

function blockLikeFg(pctRef: string): string {
  return (
    `{{ if ge (round ${pctRef}) 50 }}button-color-foreground` +
    `{{ else }}foreground{{ end }}`
  );
}

// [LAW:dataflow-not-control-flow] The burn segment heats as the cap NEARS, so
// the cascade reads the projected minutes-to-cap (smaller = hotter), the
// inverse direction of blockLikeBg's fuller-is-hotter. The not-projectable
// sentinel (-1, sorts below every threshold) is caught first so "we cannot
// project" colors calm, never error. Thresholds are var refs so a user
// overrides them through the same by-name variables cascade.
function etaHeatBg(etaRef: string, warnRef: string, errRef: string): string {
  return (
    `{{ if lt ${etaRef} 0 }}panel` +
    `{{ else }}{{ if lt ${etaRef} ${errRef} }}error` +
    `{{ else }}{{ if lt ${etaRef} ${warnRef} }}warning` +
    `{{ else }}panel{{ end }}{{ end }}{{ end }}`
  );
}

function etaHeatFg(etaRef: string, warnRef: string): string {
  return (
    `{{ if lt ${etaRef} 0 }}foreground` +
    `{{ else }}{{ if lt ${etaRef} ${warnRef} }}button-color-foreground` +
    `{{ else }}foreground{{ end }}{{ end }}`
  );
}

// ─── The settings drawer (candybar-config-engine-71o.4) ──────────────────────

// [LAW:one-source-of-truth] exception: `kind: "group"` is authoring-grammar
// sugar the loader lowers at parse time (src/config/loader/layout.ts) —
// deliberately NOT a member of the canonical LayoutNode union DslConfig.root
// requires (arranging + gating are behaviors `container` already has; "group"
// is only a spelling), so a plain `satisfies DslConfig` cannot type-check it
// inline below. Hand-lowering it here instead (writing the toggle segment +
// gated body container by hand, under the reserved `groups.` namespace) is
// NOT an option: reservedNamespaceCollisions rejects any USER-authored
// variables/actions/segments name starting with `groups.` before synthesis
// ever runs, so a hand-authored `groups.settings` segment would be rejected
// as squatting the very namespace it's trying to populate — the sugar node is
// the only legal way to populate it. This literal is unconditionally
// round-tripped through the real parseDslConfig pipeline below (see the
// module-load parse near the bottom of this file) exactly like a user's
// hand-authored JSON5, so a malformed group is still caught loudly at import
// time — the type safety net just moves from tsc to that parse, never lost.
//
// One collapsed-by-default drawer holding what the SESSION-scoped settings
// menu deliberately does not: `charset` and `colorCompatibility` — terminal
// capability facts (glyph coverage, colour depth) rather than tastes that
// vary session to session, so they have no session half to choose between —
// and one segment-scoped persist control (directoryPaletteControl, a
// per-segment palette pin rather than a whole-bar default).
//
// [LAW:one-source-of-truth] candybar-settings-ui-aok.3 moved every setting
// with BOTH halves — theme/style/look/preset/autoWrap/padding — out of this
// drawer and into the synthesized settings menu, where each is ONE control
// whose destination the `persist?` selector chooses. They used to be spelled
// twice here (`{{ menu "applyTheme" }}` beside `📌{{ menu
// "applyThemeForever" }}`), which is exactly the second representation that
// collapse removed. What is left in this drawer is durable-only by nature,
// not by omission — there is nothing for a persist? selector to choose.
//
// Placed as a sibling in row 1's horizontal container, toggled from beside the
// quick-action tray — see `root` below.
//
// [LAW:one-source-of-truth] exception: this `kind: "group"` sugar node may
// appear EXACTLY ONCE in the whole config — group names are a synthesis-wide
// namespace (synthesizeGroupDecls collects every group across every preset's
// root too), so a second `settingsDrawer` reference embedded in a preset's
// own root would be a SECOND declaration of "settings" and collide with
// itself, not a reuse of the first. It stays only in the default `root`
// below; the library presets under `presets:` reach it by switching back to
// the "default" preset from the GLOBAL settings menu, which
// synthesizeSettingsMenu splices into every preset root
// (src/config/settings-menu.ts) — never by re-embedding this group.
const settingsDrawer = {
  kind: "group",
  name: "settings",
  label: "⚙ terminal",
  direction: "horizontal",
  children: ["charsetControl", "colorCompatControl", "directoryPaletteControl"],
} as unknown as LayoutNode;

// ─── The default config ──────────────────────────────────────────────────────

// [LAW:one-source-of-truth] The AUTHORED literal, pre-synthesis. Production
// code wants the synthesized DEFAULT_DSL_CONFIG below; this is exported only
// for tests that round-trip "what a user would get by copy-pasting the
// bundled default into their own file" through the real per-file parse —
// that round-trip must start from the AUTHORED declarations, never from
// DEFAULT_DSL_CONFIG's own already-synthesized `menus.*` entries (reparsing
// those would trip the reserved-namespace guard, which exists to catch a
// user hand-declaring a name only synthesis may write).
export const RAW_DEFAULT_DSL_CONFIG = {
  globals: {
    // Picked by the daemon's basePalette resolution; user overrides in their
    // own config. Every registry theme ships the same derived spec set
    // (surface, panel, surface-active, foreground — see rich-js
    // buildPalette), so this is a pure taste call, not a compatibility one.
    // tokyo-night chosen (brandon-theming-8uj.2) over the prior
    // catppuccin-latte — a light palette that landed as a drive-by in an
    // unrelated formatting-cleanup commit and read poorly on the dark
    // terminals most users run — after live-clicking every registry theme
    // through the settings menu's theme picker: it stays legible where
    // warmer bases (gruvbox, dracula) drifted toward mud and the pastel
    // ones (rose-pine, atom-one) washed out at this contrast.
    palette: "tokyo-night",
  },

  // ─── Variables ─────────────────────────────────────────────────────────────
  // Every value the segment templates read. Sources:
  //   • input — daemon's augmented payload (see src/daemon/render-payload.ts)
  //   • env   — process environment
  //   • shell — subprocess; cached
  //   • state — per-session daemon state
  variables: {
    // From hookData, pass-through.
    current_dir: {
      kind: "input",
      path: "workspace.current_dir",
      default: "?",
    },
    project_dir: {
      kind: "input",
      path: "workspace.project_dir",
      default: "",
    },
    // Transcript path (a top-level hookData field, spread onto the payload
    // root by buildRenderPayload). Read by the quick-action tray's
    // openTranscript action — pass-through, no projection.
    transcript_path: {
      kind: "input",
      path: "transcript_path",
      default: "",
    },
    "model.display_name": {
      kind: "input",
      path: "model.display_name",
      default: "",
    },
    "session.id": { kind: "input", path: "session_id", default: "" },
    version: { kind: "input", path: "version", default: "" },
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
    // it into the payload from its own `opts.width` (the single value that
    // feeds both the wrap and this variable), so a width-paginated picker and
    // the wrap algebra can never disagree. Never cached: a resize is just a
    // new value on the same path, re-read every render. The default only
    // applies to compile-only callers that render without injecting a width.
    "term.cols": {
      kind: "input",
      path: "term.cols",
      type: "number",
      default: 80,
    },

    // home flows through the augmented payload (buildRenderPayload reads
    // HOME, falling back to USERPROFILE on Windows where HOME is often
    // unset). Sourcing via `kind: "input"` rather than `kind: "env",
    // name: "HOME"` makes the directory `~` collapse work on every
    // platform without per-platform config edits.
    home: { kind: "input", path: "home", default: "" },

    // Tmux session id flows through the daemon's augmented payload
    // (TmuxService caches by socket and never re-spawns for the lifetime of
    // the daemon, so this stays cheap). A `kind: "shell"` declaration would
    // spawn the subprocess at every cache-entry creation regardless of
    // whether the tmux segment is in the active layout — buildNeededPrefixes
    // gates the input variant so unused segments cost nothing.
    "tmux.session": { kind: "input", path: "tmux.session", default: "" },

    // Host identity — which machine this session is on, and whether the user
    // arrived over SSH. All three come through the augmented payload rather
    // than `kind: "env"` / `kind: "shell"`, and that is not a style choice:
    //
    //   • `host.ssh` CANNOT be an env var here. Variables are evaluated in the
    //     DAEMON, which is detached and serves every session for this user at
    //     once — its `SSH_*` env describes whichever shell happened to spawn
    //     it. The fact is captured by the live client and carried as a wire
    //     hint (the `termCols` pattern); the payload is the only honest source.
    //   • `host.name`/`host.user` are machine facts the daemon reads directly,
    //     so they cost two syscalls instead of a per-render subprocess.
    //
    // Defaults are the "unknown" values, and for `ssh` that is `false`: an
    // absent field (a client too old to send the hint) renders as local, which
    // is the pre-feature behavior, while the input-fallback chain records a
    // `last_error` so `cc-candybar debug vars` can still tell the two apart.
    "host.name": { kind: "input", path: "host.name", default: "" },
    "host.user": { kind: "input", path: "host.user", default: "" },
    "host.ssh": {
      kind: "input",
      path: "host.ssh",
      type: "boolean",
      default: false,
    },

    // Git — every field flows from the daemon's projected GitInfo payload.
    // The DSL's native `kind: "git"` source covers a 6-field subset
    // (branch/sha/dirty/ahead/behind/stash); using `input` here gives the
    // full 12-field surface uniformly via the augmented payload.
    "git.repoName": {
      kind: "input",
      path: "git.repoName",
      default: "",
    },
    // The repo's browsable web page, transposed from its remote by the daemon.
    // "" is the genuine "no remote a browser can open" (local-only repo, bare
    // path remote) — the toolbar's link reads that value, not a flag.
    "git.repoUrl": { kind: "input", path: "git.repoUrl", default: "" },
    "git.branch": { kind: "input", path: "git.branch", default: "" },
    "git.sha": { kind: "input", path: "git.sha", default: "" },
    "git.ahead": {
      kind: "input",
      path: "git.ahead",
      type: "number",
      default: 0,
    },
    "git.behind": {
      kind: "input",
      path: "git.behind",
      type: "number",
      default: 0,
    },
    "git.staged": {
      kind: "input",
      path: "git.staged",
      type: "number",
      default: 0,
    },
    "git.unstaged": {
      kind: "input",
      path: "git.unstaged",
      type: "number",
      default: 0,
    },
    "git.untracked": {
      kind: "input",
      path: "git.untracked",
      type: "number",
      default: 0,
    },
    "git.conflicts": {
      kind: "input",
      path: "git.conflicts",
      type: "number",
      default: 0,
    },
    "git.upstream": { kind: "input", path: "git.upstream", default: "" },
    "git.stash": {
      kind: "input",
      path: "git.stash",
      type: "number",
      default: 0,
    },
    "git.status": { kind: "input", path: "git.status", default: "clean" },
    "git.operation": { kind: "input", path: "git.operation", default: "" },
    "git.timeSinceCommit": {
      kind: "input",
      path: "git.timeSinceCommit",
      type: "number",
      default: 0,
    },

    // Forge PR/MR — the daemon's git provider resolves the branch's open PR via
    // gh/glab and projects it here. Declaring any of these turns on the network
    // lookup. [LAW:no-silent-failure] prError is non-empty ONLY when the forge
    // was asked but couldn't answer (auth/network) — distinct from "no PR"
    // (every field empty). prNumber 0 (default) ⇒ no open PR.
    "git.prNumber": {
      kind: "input",
      path: "git.prNumber",
      type: "number",
      default: 0,
    },
    "git.prState": { kind: "input", path: "git.prState", default: "" },
    "git.prUrl": { kind: "input", path: "git.prUrl", default: "" },
    "git.prError": { kind: "input", path: "git.prError", default: "" },

    // Prompt-cache expiry — epoch seconds, projected by the cache provider.
    // Same unit/shape as block/weekly resetsAt so the cacheTimer segment
    // composes `minutesUntilReset` identically. 0 (default) ⇒ no cache
    // activity found ⇒ segment's `when` hides it.
    "cache.expiresAt": {
      kind: "input",
      path: "cache.expiresAt",
      type: "number",
      default: 0,
    },

    // Usage / cost — daemon folds from the SessionUsageStore; numeric.
    "session.cost": {
      kind: "input",
      path: "session.cost",
      type: "number",
      default: 0,
    },
    "session.tokens": {
      kind: "input",
      path: "session.tokens",
      type: "number",
      default: 0,
    },
    // Budget knobs — pure config constants, user overrides in their file.
    // [LAW:dataflow-not-control-flow] amount defaults 0, the budgetStatus
    // helper's non-displayable value, so with no user override the session
    // segment renders byte-identically to its pre-budget form through the
    // same unconditional template — opt-in is a value, not a config mode.
    // Matches the legacy shipped default (budget.session had a threshold but
    // no amount ⇒ suffix off until the user sets an amount).
    "session.budget.amount": { kind: "literal", value: 0 },
    "session.budget.warningThreshold": { kind: "literal", value: 80 },

    // Today — daemon folds today's cross-session total from the SessionUsageStore.
    "today.cost": {
      kind: "input",
      path: "today.cost",
      type: "number",
      default: 0,
    },
    "today.tokens": {
      kind: "input",
      path: "today.tokens",
      type: "number",
      default: 0,
    },
    // Budget knobs — pure config constants, user overrides in their file.
    "today.budget.amount": { kind: "literal", value: 50 },
    "today.budget.warningThreshold": { kind: "literal", value: 80 },

    // Block — daemon projects directly from hookData.rate_limits.five_hour;
    // resetsAt is raw epoch seconds
    // so the template can compose `minutesUntilReset .block.resetsAt` (the
    // same chain weekly uses, single composition point).
    "block.nativeUtilization": {
      kind: "input",
      path: "block.nativeUtilization",
      type: "number",
      default: 0,
    },
    "block.resetsAt": {
      kind: "input",
      path: "block.resetsAt",
      type: "number",
      default: 0,
    },
    // Budget knob — overridable per-config through the variables-merge-by-
    // name cascade. Matches the legacy DEFAULT_CONFIG.budget.block.warning
    // Threshold.
    "block.budget.warningThreshold": { kind: "literal", value: 80 },

    // Weekly — direct projection of hookData.rate_limits.seven_day.
    "weekly.percentage": {
      kind: "input",
      path: "weekly.percentage",
      type: "number",
      default: 0,
    },
    "weekly.resetsAt": {
      kind: "input",
      path: "weekly.resetsAt",
      type: "number",
      default: 0,
    },
    "weekly.budget.warningThreshold": { kind: "literal", value: 80 },

    // Burn rate + cap projection — daemon-derived (see render-payload.ts).
    // Each projection is ABSENT when not projectable; the var-system fills the
    // -1 default, a structurally-impossible value the burnrate helpers read as
    // "—" [LAW:no-silent-failure] (0 minutes / $0-per-hr are real, displayable
    // values, so they cannot double as the absence marker).
    "burn.costPerHour": {
      kind: "input",
      path: "burn.costPerHour",
      type: "number",
      default: -1,
    },
    "block.etaMinutes": {
      kind: "input",
      path: "block.etaMinutes",
      type: "number",
      default: -1,
    },
    "weekly.etaMinutes": {
      kind: "input",
      path: "weekly.etaMinutes",
      type: "number",
      default: -1,
    },
    // ETA-heat thresholds (minutes-to-cap) — overridable per-config through the
    // variables-merge-by-name cascade, like the *.budget.warningThreshold knobs.
    "burn.eta.warnMinutes": { kind: "literal", value: 60 },
    "burn.eta.errorMinutes": { kind: "literal", value: 30 },

    // Token throughput for the active turn — daemon-derived tok/s on three lanes
    // (render-payload.ts: successive-render delta over the SessionUsageStore).
    // Same absence idiom as burn: -1 is the structurally-impossible default the
    // `formatSpeed` helper reads as "—" [LAW:no-silent-failure] (0 tok/s is a
    // real reading, so it cannot double as the absence marker). Each lane is
    // independently absent — `input` reads "—" mid-stream while `output` flows.
    "speed.input": {
      kind: "input",
      path: "speed.input",
      type: "number",
      default: -1,
    },
    "speed.output": {
      kind: "input",
      path: "speed.output",
      type: "number",
      default: -1,
    },
    "speed.total": {
      kind: "input",
      path: "speed.total",
      type: "number",
      default: -1,
    },
    // Recent burn-rate trend: a comma-delimited series of total-lane tok/s the
    // daemon folds from its sample ring (render-payload.ts). A series cannot
    // cross the scalar var-system seam, so it travels as a string the
    // `sparkline` helper decodes. Default "" is the genuine "no history yet"
    // form (the helper renders nothing); the segment gates on it being present.
    "speed.history": {
      kind: "input",
      path: "speed.history",
      type: "string",
      default: "",
    },

    // Context — daemon fetches via ContextProvider; contextLeftPercentage.
    "context.totalTokens": {
      kind: "input",
      path: "context.totalTokens",
      type: "number",
      default: 0,
    },
    "context.contextLeft": {
      kind: "input",
      path: "context.contextLeft",
      type: "number",
      default: 100,
    },

    // Metrics — daemon fetches via MetricsProvider; numeric.
    "metrics.lastResponseTime": {
      kind: "input",
      path: "metrics.lastResponseTime",
      type: "number",
      default: 0,
    },
    "metrics.responseTime": {
      kind: "input",
      path: "metrics.responseTime",
      type: "number",
      default: 0,
    },
    "metrics.sessionDuration": {
      kind: "input",
      path: "metrics.sessionDuration",
      type: "number",
      default: 0,
    },
    "metrics.messageCount": {
      kind: "input",
      path: "metrics.messageCount",
      type: "number",
      default: 0,
    },
    "metrics.linesAdded": {
      kind: "input",
      path: "metrics.linesAdded",
      type: "number",
      default: 0,
    },
    "metrics.linesRemoved": {
      kind: "input",
      path: "metrics.linesRemoved",
      type: "number",
      default: 0,
    },

    // No page-cursor var: a {{ menu }} synthesizes its own page
    // cursor (state var + int action, named by menuPageKey) under the reserved
    // menus.* namespace, alongside its open-state.
  },

  // ─── Segments ──────────────────────────────────────────────────────────────
  // Every built-in. Templates ported from the parity bindings; bg/fg are
  // palette spec names resolved against the active theme. `when` predicates
  // hide a segment when its primary signal is absent (no git repo, no version
  // field, no env var, no tmux, no rate-limit window).
  //
  // [LAW:one-source-of-truth] Templates author CONTENT only — the intra-cell
  // padding (the space each side of a cell) is render chrome synthesized
  // structurally from the one resolved globals.padding (default 1), never
  // authored here. A template with leading/trailing spaces would render them
  // IN ADDITION to the structural padding.
  segments: {
    directory: {
      template: DIR_TEMPLATE,
      bg: "surface",
      fg: "foreground",
    },
    model: {
      template: "✱ {{ formatModelName .model.display_name }}",
      bg: "panel",
      fg: "foreground",
      when: '{{ ne .model.display_name "" }}',
    },
    sessionId: {
      template: "⌗{{ trunc 8 .session.id }}",
      bg: "surface",
      fg: "foreground",
      when: '{{ ne .session.id "" }}',
    },
    version: {
      template: "◈ v{{ .version }}",
      bg: "surface",
      fg: "foreground",
      when: '{{ ne .version "" }}',
    },
    tmux: {
      template: 'tmux:{{ .tmux.session | default "none" }}',
      bg: "surface-active",
      fg: "foreground",
      when: '{{ ne .tmux.session "" }}',
    },
    // "You are not on your own machine." Modelled on the git-taculous zsh
    // theme, which prepends `(%n@%m)` to the prompt under SSH and shows
    // nothing locally — you already know your own hostname.
    //
    // [LAW:dataflow-not-control-flow] Presence IS the signal. There is no SSH
    // "mode" and no force-on flag (git-taculous's GITTACULOUS_ENABLE_SSH_THEME
    // would be a flag with no deletion date, [LAW:no-mode-explosion]); the cell
    // exists exactly when the value says so, like tmux/block/weekly. A user who
    // wants it always-on overrides this one segment's `when` to `"true"`.
    //
    // `bg: "warning"` is load-bearing, not decoration: warning is one of the
    // hue-ANCHORED palette roots, so it survives every theme, look, and
    // per-segment hue transposition still reading as an alert. Any other slot
    // would drift with the hue stepper and could land camouflaged against its
    // neighbours — exactly what a "wrong machine" warning must never do.
    // `contrastOn (bgOf)` then derives a readable foreground from whatever that
    // resolves to, rather than betting a fixed `foreground` stays legible.
    //
    // Each half falls back to "?" so a failed hostname/username read renders
    // `⇄ ?@?` — still unmistakably "remote", and legibly missing its identity
    // rather than a blank that reads as a rendering bug ([LAW:no-silent-failure]).
    host: {
      template:
        '⇄ {{ .host.user | default "?" }}@{{ .host.name | default "?" }}',
      bg: "warning",
      fg: "{{ contrastOn (bgOf) }}",
      when: "{{ .host.ssh }}",
    },
    git: {
      template: GIT_TEMPLATE,
      bg: "surface-active",
      // A computed `fg:` — the field is a template evaluating to a color
      // reference, and `bgOf` is available here because a segment's background
      // is resolved before its foreground. Structural text therefore sits a
      // fixed distance from THIS segment's background whatever theme or look
      // is in effect.
      fg: GIT_QUIET_FG,
      when: '{{ ne .git.branch "" }}',
    },
    gitaculous: {
      // Recolored from raw green/red (render-bugs-pdu.3's era) to semantic
      // palette names (brandon-segments-3eo.1), then unified against `git`'s
      // choice of color per fact via the shared GIT_COLOR table above
      // (brandon-segments-3eo.1.1 — the two had drifted: branch, untracked,
      // and stash each disagreed with `git`'s coloring of the same fact).
      // staged/ahead share `success` (positive — ready to commit / unpushed
      // additions), unstaged/behind share `warning` (needs attention),
      // untracked/stash share `accent` (their own GIT_COLOR entries, kept
      // visually distinct from unstaged by using a different glyph, not a
      // different color, so "U" vs "?" reads apart at a glance), conflicts
      // gets its own `error`, branch gets `primary`.
      //
      // Everything the template does NOT paint — the "(git)" label, repo name,
      // the operation and upstream brackets, the sha, the elapsed-time
      // annotation — renders in the segment's quiet `fg:` and recedes, so the
      // eye lands on the operative colored facts first (brandon-segments-
      // 3eo.1.1.1: live feedback that "most of it" read as one flat color when
      // only two facts happened to be present). Note that this needs no markup
      // in the template — including around `{{ template "formatTimeSince" }}`,
      // which as a top-level Go-template action could never have been wrapped
      // in a styling call at all. Making quiet the default rather than a
      // wrapper is what put that token in reach.
      template:
        "(git)" +
        '{{ if ne .git.repoName "" }} {{ .git.repoName }}{{ end }}' +
        '{{ if ne .git.operation "" }} [{{ .git.operation }}]{{ end }}' +
        '{{ if ne .git.sha "" }} {{ .git.sha }}{{ end }}' +
        "{{ if or (gt .git.staged 0) (gt .git.unstaged 0) (gt .git.untracked 0) (gt .git.conflicts 0) }} " +
        `{{ if gt .git.staged 0 }}${paint("staged", '"S"')}{{ end }}` +
        `{{ if gt .git.unstaged 0 }}${paint("unstaged", '"U"')}{{ end }}` +
        `{{ if gt .git.untracked 0 }}${paint("untracked", '"?"')}{{ end }}` +
        `{{ if gt .git.conflicts 0 }}${paint("conflicts", '(printf "!%v" .git.conflicts)')}{{ end }}` +
        "{{ end }}" +
        ` ⎇ ${paint("branch", ".git.branch")}` +
        '{{ if ne .git.upstream "" }} [{{ .git.upstream }}' +
        "{{ if or (gt .git.ahead 0) (gt .git.behind 0) }} " +
        `{{ if gt .git.ahead 0 }}${paint("ahead", '(printf "+%v" .git.ahead)')}{{ end }}` +
        "{{ if and (gt .git.ahead 0) (gt .git.behind 0) }}/{{ end }}" +
        `{{ if gt .git.behind 0 }}${paint("behind", '(printf "-%v" .git.behind)')}{{ end }}` +
        "{{ end }}]{{ end }}" +
        `{{ if gt .git.stash 0 }} ${paint("stash", '(printf "(%v stashed)" .git.stash)')}{{ end }}` +
        '{{ if gt .git.timeSinceCommit 0 }} ◷ {{ template "formatTimeSince" .git.timeSinceCommit }}{{ end }}',
      bg: "surface-active",
      fg: GIT_QUIET_FG,
      when: '{{ ne .git.branch "" }}',
    },
    // Git PR/MR — the branch's open pull/merge request as a clickable link.
    // OPT-IN: declared but NOT in the default root (it adds a network gh/glab
    // call). Add "gitPr" to a container's children to enable it. The `{{ link
    // url text }}` emits ONE OSC-8 region carrying the https PR url, so the
    // CLICK is handled by the terminal/OS (opens the browser) — no daemon verb.
    // [LAW:no-silent-failure] Three render states from the data: an open PR
    // (prUrl set) renders the link; a lookup FAILURE (prError set, prUrl empty)
    // renders a distinct ⚠ marker so an outage is not mistaken for "no PR";
    // no PR (both empty) leaves the `when` gate false and the segment absent.
    gitPr: {
      // The pad spaces are structural chrome now, OUTSIDE the OSC-8 link
      // region — the clickable area is the glyph text itself.
      template:
        '{{ if ne .git.prUrl "" }}' +
        '{{ link .git.prUrl (printf "⇆ #%v" .git.prNumber) }}' +
        "{{ else }}⚠ PR{{ end }}",
      bg: "surface-active",
      fg: "foreground",
      when: '{{ or (ne .git.prUrl "") (ne .git.prError "") }}',
    },
    // Quick-action tray — the default bar's interactivity: copy the session id,
    // open the project dir / transcript (this session's jsonl) in the editor,
    // open the repo's web page in the browser, and toggle layout edit mode.
    // (copyDir — copy the cwd — stays declared as an action below for users who
    // want a fifth glyph; it is simply not in the default tray.)
    // [LAW:locality-or-seam] The glyph is the REPRESENTATION; the named action
    // (below) is the BEHAVIOR; the action name is the seam between them. Re-glyph
    // without touching behavior; re-target without touching this template. Each
    // `{{ action … }}` emits one OSC-8 clickable region whose URL the wire codec
    // owns end-to-end.
    //
    // `↗ repo` is the one glyph here that is NOT an action: the daemon already
    // resolved the remote to an https page, so `{{ link }}` hands that URL
    // straight to the terminal/OS (same seam the gitPr segment uses) — routing a
    // public web URL through a cc-candybar:// verb would buy nothing. It is
    // gated on the VALUE (`ne … ""`), not on a flag: a local-only repo simply
    // supplies no page and the glyph is absent. [LAW:dataflow-not-control-flow]
    //
    // `✎ edit`/`✎ done` (brandon-layout-edit-2gc.4) is the bundled default's
    // ONLY reference to the reserved `edit.toggle` action — referencing it
    // anywhere is what opts this config into edit mode (see
    // docs/interaction-authoring.md's "Edit mode" section), and this tray
    // segment is where it lives.
    //
    // [LAW:carrying-cost] Placement resolves a self-lockout tension .3 flagged
    // (see the epic's tickets): once edit mode is open, EVERY ordinary segment
    // gets its own removable `-`, including whichever one hosts the trigger —
    // a config can, in principle, remove its own way back into edit mode.
    // Giving the trigger its own standalone segment would make that a one-click
    // accident. Folding it into `toolbar` instead means removing the trigger
    // requires removing the WHOLE quick-action tray — the same deliberate,
    // symmetric risk every other multi-purpose segment already carries, not a
    // bespoke edit-mode hazard — and it costs the default bar one glyph of
    // width instead of a whole new segment's cell+padding+joiner overhead. The
    // risk is bounded either way: `-` only removes the segment from this
    // preset's tree (`edit.mode` itself is untouched SessionState), so the
    // rest of the chrome — every remaining `+`/`-` in the bar — stays visible,
    // and any of them can `+` `toolbar` straight back
    // (test/dsl-layout-edit.test.ts covers the full round trip through a
    // real RenderCache reload; test/dsl-edit-mode.test.ts covers the click
    // itself and that edit.mode survives it).
    toolbar: {
      template:
        '{{ action "copySession" "⎘ id" }}' +
        ' {{ action "openProject" "↗ proj" }} {{ action "openTranscript" "↗ log" }}' +
        '{{ if ne .git.repoUrl "" }} {{ link .git.repoUrl "↗ repo" }}{{ end }}' +
        ' {{ action "edit.toggle" "✎ edit" "✎ done" }}',
      bg: "surface",
      fg: "foreground",
    },
    session: {
      template:
        '§ {{ template "formatCost" .session.cost }} ({{ template "formatTokens" .session.tokens }})' +
        '{{ template "budgetStatus" (dict "cost" .session.cost "budget" .session.budget.amount "warn" .session.budget.warningThreshold) }}',
      bg: "surface",
      fg: "foreground",
    },
    today: {
      template:
        '☉ {{ template "formatCost" .today.cost }} ({{ template "formatTokens" .today.tokens }})' +
        '{{ template "budgetStatus" (dict "cost" .today.cost "budget" .today.budget.amount "warn" .today.budget.warningThreshold) }}',
      bg: "surface",
      fg: "foreground",
    },
    block: {
      template:
        "◱ {{ round .block.nativeUtilization }}% " +
        '({{ template "formatLongTimeRemaining" (minutesUntilReset .block.resetsAt) }})',
      bg: blockLikeBg(
        ".block.nativeUtilization",
        ".block.budget.warningThreshold",
      ),
      fg: blockLikeFg(".block.nativeUtilization"),
      // Hide unless we have a five-hour-window snapshot.
      when: "{{ gt .block.resetsAt 0 }}",
    },
    weekly: {
      template:
        "◑ {{ round .weekly.percentage }}% " +
        '({{ template "formatLongTimeRemaining" (minutesUntilReset .weekly.resetsAt) }})',
      bg: blockLikeBg(".weekly.percentage", ".weekly.budget.warningThreshold"),
      fg: blockLikeFg(".weekly.percentage"),
      when: "{{ gt .weekly.resetsAt 0 }}",
    },
    // Burn rate + cap projection: "$X/hr · Nm to 5h · Nd to wk". The headline
    // number of a usage monitor — how fast you are spending and when you hit
    // the wall. All math is daemon-side (render-payload.ts); the template only
    // formats. Heats as the 5h cap nears (etaHeat*). Shown when either
    // rate-limit window is active — the same signal block/weekly gate on.
    burnrate: {
      template:
        '⚡ {{ template "formatRate" .burn.costPerHour }} · ' +
        '{{ template "formatEta" .block.etaMinutes }} to 5h · ' +
        '{{ template "formatEta" .weekly.etaMinutes }} to wk',
      bg: etaHeatBg(
        ".block.etaMinutes",
        ".burn.eta.warnMinutes",
        ".burn.eta.errorMinutes",
      ),
      fg: etaHeatFg(".block.etaMinutes", ".burn.eta.warnMinutes"),
      when: "{{ or (gt .block.resetsAt 0) (gt .weekly.resetsAt 0) }}",
    },
    // Token throughput for the active turn — output / input / total tok/s, each a
    // successive-render delta computed daemon-side (render-payload.ts); the
    // template only formats. Declared-but-opt-in (NOT in the default root, like
    // block/weekly/burnrate): a user adds `speed` to their layout. Each lane reads
    // "—" when idle/between turns ([LAW:no-silent-failure] — never a stale or
    // divide-by-zero number). Visible once the session has done any work (stable,
    // no layout flicker); `output` is the live generation rate, `input` spikes at
    // turn start, `total` is their sum.
    speed: {
      template:
        '⇅ out {{ template "formatSpeed" .speed.output }} · ' +
        'in {{ template "formatSpeed" .speed.input }} · ' +
        'tot {{ template "formatSpeed" .speed.total }}',
      bg: "panel",
      fg: "foreground",
      when: "{{ gt .session.tokens 0 }}",
    },
    // Burn-rate sparkline: the recent total-lane tok/s trend as a unicode
    // mini-graph. Declared-but-opt-in (NOT in the default root, like speed /
    // block / weekly): a user adds `tokenSparkline` to their layout. The
    // `sparkline` helper decodes the daemon-owned series and draws it; `24`
    // caps the glyph count to the cell, showing the live tail of the ring. The
    // segment's fg colors the whole graph (no per-glyph color). Gated on the
    // history being present so the cell never renders empty (the series needs
    // two samples before its first bar). [LAW:effects-at-boundaries] — all the
    // history lives in the daemon ring, the template only draws.
    tokenSparkline: {
      template: "⚡ {{ sparkline .speed.history 24 }}",
      bg: "panel",
      fg: "foreground",
      when: '{{ ne .speed.history "" }}',
    },
    // Prompt-cache warmth countdown. minutesUntilReset clamps a past expiry
    // to 0, so an expired cache renders "cold" (and reads red via the ≤8
    // arm) rather than a negative number. [LAW:dataflow-not-control-flow]
    // glyph + "cold"/"Nm" + color all derive from the one expiry value; the
    // provider supplies no display state. Constant `surface` bg with a
    // fg-only threshold cascade mirrors the legacy inline-colored text
    // (warm = normal, ≤20m = warning, ≤8m/cold = error).
    cacheTimer: {
      template:
        "◴ {{ if le (minutesUntilReset .cache.expiresAt) 0 }}cold" +
        "{{ else }}{{ minutesUntilReset .cache.expiresAt }}m{{ end }}",
      bg: "surface",
      fg:
        "{{ if le (minutesUntilReset .cache.expiresAt) 8 }}error" +
        "{{ else }}{{ if le (minutesUntilReset .cache.expiresAt) 20 }}warning" +
        "{{ else }}foreground{{ end }}{{ end }}",
      when: "{{ gt .cache.expiresAt 0 }}",
    },
    context: {
      template:
        "◔ {{ formatInteger .context.totalTokens }} ({{ .context.contextLeft }}%)",
      bg:
        "{{ if le .context.contextLeft 20 }}error" +
        "{{ else }}{{ if le .context.contextLeft 40 }}warning" +
        "{{ else }}surface-active{{ end }}{{ end }}",
      fg:
        "{{ if le .context.contextLeft 40 }}button-color-foreground" +
        "{{ else }}foreground{{ end }}",
      when: "{{ gt .context.totalTokens 0 }}",
    },
    metrics: {
      // [LAW:dataflow-not-control-flow] Each part guards on its own value
      // rather than gating the whole segment on a single dimension. With
      // MetricsPayload's fields independently optional and pickNonNull
      // dropping nulls (see src/daemon/render-payload.ts), an absent field
      // resolves through the var-system fallback chain to 0 — the same
      // falsy shape the per-part `if` test treats as hidden. The segment-
      // level `when` survives as a weak any-present check so a payload
      // with zero metrics data renders no cell at all (an empty template
      // would otherwise produce a single-space bg-styled cell).
      //
      // [LAW:one-source-of-truth] exception: each arm's leading space is the
      // SEPARATOR between present parts (only data can decide which part is
      // first, so no static strip can remove just the first one), and the
      // trailing space mirrors it for symmetry. At the default padding this
      // cell therefore reads one space wider per side than its siblings.
      template:
        '{{ if .metrics.lastResponseTime }} Δ {{ template "formatResponseTime" .metrics.lastResponseTime }}{{ end }}' +
        '{{ if .metrics.responseTime }} ⧖ {{ template "formatResponseTime" .metrics.responseTime }}{{ end }}' +
        '{{ if .metrics.sessionDuration }} ⧗ {{ template "formatDuration" .metrics.sessionDuration }}{{ end }}' +
        "{{ if .metrics.messageCount }} ◆ {{ .metrics.messageCount }}{{ end }}" +
        "{{ if .metrics.linesAdded }} + {{ .metrics.linesAdded }}{{ end }}" +
        "{{ if .metrics.linesRemoved }} - {{ .metrics.linesRemoved }}{{ end }} ",
      bg: "panel",
      fg: "foreground",
      when:
        "{{ or .metrics.lastResponseTime .metrics.responseTime" +
        " .metrics.sessionDuration .metrics.messageCount" +
        " .metrics.linesAdded .metrics.linesRemoved }}",
    },
    // ── The TWO globals steppers left in this drawer. `charset` and
    // `colorCompatibility` have no SessionState half at all — they describe
    // the terminal, not a taste that varies per session — so `persist` is
    // genuinely their only seam and there is no destination for a `persist?`
    // selector to choose between. Everything with both halves
    // (theme/style/look/preset/autoWrap/padding) moved to the synthesized
    // settings menu as ONE dual control each (candybar-settings-ui-aok.3).
    // Each pairs a `persist` control with a `↺` reset (docs' persist/reset
    // convention); labels read `.field.effective` (the daemon-resolved value
    // BuildLineOptions actually rendered with), never a restated literal.
    charsetControl: {
      template:
        "{{ .charset.effective }} " +
        `{{ menu "applyCharsetForever" "${DISCLOSURE_GLYPH_CLOSED}" "${DISCLOSURE_GLYPH_OPEN}" }} ` +
        '{{ action "resetCharset" "↺" }}',
      bg: "surface",
      fg: "foreground",
    },
    colorCompatControl: {
      template:
        "{{ .colorCompatibility.effective }} " +
        `{{ menu "applyColorCompatForever" "${DISCLOSURE_GLYPH_CLOSED}" "${DISCLOSURE_GLYPH_OPEN}" }} ` +
        '{{ action "resetColorCompat" "↺" }}',
      bg: "surface",
      fg: "foreground",
    },
    // [LAW:verifiable-goals] candybar-config-engine-71o.6's own acceptance
    // bar, mirrored from .3/.5: at least ONE segment-scoped field must be
    // menu-able from the BUNDLED default with no hand-authored actions.
    // `directory` is the demo target — always visible, palette-driven
    // bg/fg, so an override is immediately legible. The persist/reset pair
    // below targets `segments.directory.palette` (not a Globals field),
    // proving the option-domain-as-data seam generalizes to segment-scoped
    // keys with zero engine edits beyond opening the key namespace itself
    // (loader/persist-target.ts) — the SAME `from: "themes"` domain
    // applyThemeForever already uses.
    // [LAW:one-source-of-truth] exception: unlike charsetControl/
    // the other controls' `.field.effective` labels, there is no
    // `segments.directory.palette.effective` payload projection — adding one
    // would require threading the full DslConfig through
    // buildRenderPayload's signature (today built from EffectiveGlobals
    // alone), a change with no other motivation than this one label. The
    // control still writes/persists/resets correctly without it: per
    // render/action.ts's CONFIG_KEY_TO_EFFECTIVE_VAR, a persist key with no
    // effective-var entry writes fine and only loses the picker's "current
    // selection" highlight — a documented, already-accepted degrade path,
    // not a bug.
    directoryPaletteControl: {
      template:
        "🎨 directory " +
        `{{ menu "applyDirectoryPaletteForever" "${DISCLOSURE_GLYPH_CLOSED}" "${DISCLOSURE_GLYPH_OPEN}" }} ` +
        '{{ action "resetDirectoryPalette" "↺" }}',
      bg: "surface",
      fg: "foreground",
    },
  },

  // Default layout — the canonical Root: a map of NAMED rows (`satisfies
  // DslConfig` requires the lowered node form inside each row; the terse
  // Option-A `{ h/v/seg }` grammar is the loader's authoring surface for user
  // JSON, not this typed literal — the one exception being `settingsDrawer`
  // above, whose `kind: "group"` sugar has no canonical-form equivalent it
  // could be hand-lowered to; see its own comment).
  //
  // [LAW:one-source-of-truth] The row NAMES are the merge keys. A user file's
  // `root: { rows: { status: { h: [...] } } }` replaces exactly the row it
  // names and inherits the other in place — the same by-name cascade every
  // other section merges with — and `status: { h: [] }` removes one. This
  // literal is read both as JSON (parsed like a user file) and as the typed
  // base it merges onto, so the canonical shape and the authoring shape are
  // one object by construction.
  //
  // Two always-visible rows: an IDENTITY + ACTIONS row (where am I / what can I do here — the directory, the verbose
  // `gitaculous` line, the quick-action tray: copy session id, open project /
  // transcript in the editor, and the settingsDrawer toggle) over a STATUS row
  // (what's happening now — model, context-window fill, prompt-cache warmth,
  // and the 5h / 7d rate-limit quotas). The settingsDrawer (candybar-config-
  // engine-71o.4) sits on the identity row beside the tray — collapsed by
  // default and visually silent (a single "⚙ settings ▸" cell) — and reveals a
  // third row of every bar-mutable display default (theme, style, look,
  // charset, colorCompatibility, autoWrap, padding) on the line immediately
  // below row 1 when opened, exactly where a `{{ menu }}`'s own picker body
  // would drop. Each row zips its segments through the powerline joiner; `\n`
  // separates the rows.
  //
  // [LAW:dataflow-not-control-flow] Every status segment is when-gated on its
  // own signal (no repo → the identity row is just the directory + tray; no
  // active rate-limit window → block/weekly drop; no cache activity → cacheTimer
  // drops). A row therefore only ever shows the segments that have real data —
  // the layout is chosen by the data, not by branches — so the default never
  // paints an empty or placeholder cell. The directory and the tray have no
  // `when`, so row 1 always anchors the bar.
  root: {
    rows: {
      identity: {
        kind: "container",
        direction: "horizontal",
        children: [
          // Leads the identity row: the first thing to read is WHICH MACHINE,
          // because it reframes every path and branch to its right. Same
          // placement git-taculous gives `(%n@%m)` — ahead of the directory.
          // Gated off entirely on a local session, so the row still opens with
          // `directory` where it always has.
          { kind: "segment", name: "host" },
          { kind: "segment", name: "directory" },
          { kind: "segment", name: "gitaculous" },
          { kind: "segment", name: "toolbar" },
          settingsDrawer,
        ],
      },
      status: {
        kind: "container",
        direction: "horizontal",
        children: [
          { kind: "segment", name: "model" },
          { kind: "segment", name: "context" },
          { kind: "segment", name: "cacheTimer" },
          { kind: "segment", name: "block" },
          { kind: "segment", name: "weekly" },
        ],
      },
    },
  },

  // [LAW:locality-or-seam] The quick-action tray's behaviors, decoupled by NAME
  // from the `toolbar` segment's glyphs above. copy/open evaluate a Go-template
  // against the live render scope at click time and write NO SessionState, so
  // they derive no state validator (no gate) — they are pure click effects.
  //
  // [LAW:single-enforcer] Each template emits a RAW value; the click-wire codec
  // (effectsUrl → encodeSegments) owns ALL percent-encoding and the verb's
  // `oneArg` owns the single matching decode — so the template never hand-rolls
  // a `urlEncode`, and the path round-trips untouched through one codec.
  //
  // open* route through the open-vscode verb (`open -a "Visual Studio Code"
  // <path>`), so they pass a bare filesystem path — a directory or a file the
  // editor opens directly — NOT a `vscode://` URL (which `open -a` would treat
  // as a literal filename, not a deep link).
  actions: {
    copySession: { copy: "{{ .session.id }}" },
    copyDir: { copy: "{{ .current_dir }}" },
    openProject: { open: "{{ .project_dir }}" },
    openTranscript: { open: "{{ .transcript_path }}" },

    // [LAW:locality-or-seam] The settings-drawer controls' behaviors
    // (candybar-config-engine-71o.4), decoupled by NAME from
    // charsetControl/colorCompatControl below. These are durable-only by
    // NATURE, not by omission: `charset` and `colorCompatibility` describe the
    // terminal (glyph coverage, colour depth) rather than a taste that varies
    // between sessions, so they have no SessionState half for a `persist?`
    // selector to choose between — which is exactly why
    // candybar-settings-ui-aok.3 left them here while moving every
    // both-halves setting into the settings menu as one dual control. Each
    // writes the config DEFAULT into the config file itself (candybar-
    // config-dqe: the file is the one durable store), gated by the SAME
    // deriveConfigActionValidators pass, and is paired with a `reset` so a
    // drawer choice is always undoable from the bar.
    applyCharsetForever: { persist: "charset", from: "charsets" },
    resetCharset: { reset: "charset" },
    applyColorCompatForever: {
      persist: "colorCompatibility",
      from: "colorCompatibilities",
    },
    resetColorCompat: { reset: "colorCompatibility" },

    // [LAW:locality-or-seam] The segment-palette control's behavior
    // (candybar-config-engine-71o.6), decoupled by NAME from
    // directoryPaletteControl below. The target key is `segments.directory.
    // palette` — NOT a Globals field — so it rides the SAME generic
    // `from`/`reset` machinery every other persist pair here uses, over a
    // key namespace loader/persist-target.ts opened alongside the pre-
    // existing Globals-field one. Like charset/colorCompatibility, this field has
    // no SessionState half at all: a per-segment `palette:` is a static pin
    // that ignores the session theme by design (src/dsl/render.ts), so
    // `persist` is its only seam.
    applyDirectoryPaletteForever: {
      persist: "segments.directory.palette",
      from: "themes",
    },
    resetDirectoryPalette: { reset: "segments.directory.palette" },
  },

  // ─── Looks ───────────────────────────────────────────────────────────────
  // Named theme ADAPTATIONS — each is a full rich-js ThemeKey applied on top
  // of whatever base theme is active (a transform, not a palette), so every
  // look composes with every theme: pick theme, then pick look. Selected per
  // session via the `look` SessionState key (an action `{ set: "look", from:
  // "looks" }` + a `{{ menu }}`), exactly the theme/style selection seam.
  // [LAW:one-source-of-truth] Merges by name (user wins per name), so this
  // stdlib — including the "none" identity floor effectiveLookName collapses
  // to — is present in every merged config by construction.
  looks: {
    // [LAW:dataflow-not-control-flow] "none" is just the identity look — the
    // resolution floor as a value, not a special case (rich-js's isIdentityKey
    // fast-path makes it free). Spelled literally (not rich-js IDENTITY /
    // INVERT_LIGHTNESS) so the bundled default remains inert JSON-shaped data
    // a user file can mirror axis-for-axis; the loader normalizes user specs
    // onto the same identity axes.
    none: { hueShift: 0, chromaScale: 1, lightnessScale: 1, lightnessShift: 0 },
    // Saturation up/down — chroma is multiplicative, hue and lightness held.
    vivid: {
      hueShift: 0,
      chromaScale: 1.35,
      lightnessScale: 1,
      lightnessShift: 0,
    },
    muted: {
      hueShift: 0,
      chromaScale: 0.55,
      lightnessScale: 1,
      lightnessShift: 0,
    },
    // Lightness down (scale) / up (shift) — dim compresses toward black,
    // bright lifts everything a step; anchors stay hue-locked by rich-js.
    dim: {
      hueShift: 0,
      chromaScale: 1,
      lightnessScale: 0.85,
      lightnessShift: 0,
    },
    bright: {
      hueShift: 0,
      chromaScale: 1,
      lightnessScale: 1,
      lightnessShift: 0.08,
    },
    // The dark↔light "octave" flip (rich-js INVERT_LIGHTNESS: L' = 1 - L) —
    // errors stay red, dark-on-light becomes light-on-dark.
    inverted: {
      hueShift: 0,
      chromaScale: 1,
      lightnessScale: -1,
      lightnessShift: 1,
    },
  },

  // ─── Presets ─────────────────────────────────────────────────────────────
  // Named config FRAGMENTS — each an alternative `root` + display `globals`,
  // i.e. a whole arrangement of the bar rather than one knob. A preset is to
  // configuration what a look is to a theme, and rides the identical seam:
  // selected per session via the `preset` SessionState key — or pinned as the
  // durable default via `globals.preset` — through the settings menu's ONE
  // dual preset control (src/config/settings-menu.ts), resolved as session
  // pick over globals.preset over this floor.
  // [LAW:one-source-of-truth] Merges by name (user wins per name), so this
  // stdlib is present in every merged config by construction, exactly as
  // looks' "none"/"vivid"/"muted"/… is — a user redefining "compact" or
  // "verbose" wins per name; the floor cannot be shadowed by anything but an
  // empty fragment, because that IS what it already is.
  //
  // [LAW:carrying-cost] Each library preset stages only real deltas from the
  // bundled default's own root (declared above) — no preset here restates a
  // segment's template, bg, or fg, only which of the ALREADY-declared
  // segments appear and in what arrangement, per the field cap
  // (brandon-presets-0yk.1's premise note): a bundled preset can only STAGE
  // segments DEFAULT_DSL_CONFIG.segments already declares, never introduce
  // one.
  //
  // [LAW:verifiable-goals] Every entry here is asserted error-cell-free at
  // 80/120/200 columns against a RICH payload in
  // test/default-dsl-config.test.ts (the same checkPayload fixture check.ts
  // uses) — curated by actually rendering each arrangement, not by reading
  // the segment names off the page.
  presets: {
    // [LAW:dataflow-not-control-flow] "default" is just the identity fragment
    // — the resolution floor as a value, not a special case. An empty fragment
    // declares no `root` and no `globals`, so it stages the config's own, which
    // is precisely what "no preset chosen" means. This is the bundled default's
    // OWN two-row (identity / status) arrangement declared as `root` above —
    // it needs no entry of its own here beyond the floor, because staging it
    // AS a named fragment would be a byte-for-byte copy of `root` that could
    // silently drift from it the moment either changed.
    default: {},

    // Single-row arrangement for narrow terminals and split panes — the
    // situation where a user most wants a different arrangement and least
    // wants to hand-write one. Keeps only the three facts a split pane most
    // needs at a glance (where am I / what's the git state / how much context
    // is left), the quiet one-line `git` segment rather than the multi-fact
    // `gitaculous`, and `padding: 0` to buy back the chrome a narrow column
    // can't spare.
    //
    // [LAW:no-silent-failure] A session that switches TO compact is never
    // stranded: synthesizeSettingsMenu splices the global settings menu — and
    // with it the preset switcher — into EVERY preset root, so one click back
    // to "default" restores everything compact traded away for width. That is
    // why this root carries no preset control of its own: one guaranteed door
    // per root, minted once and referenced, not a segment each preset must
    // remember to carry [LAW:one-source-of-truth].
    compact: {
      root: {
        kind: "container",
        direction: "horizontal",
        children: [
          { kind: "segment", name: "directory" },
          { kind: "segment", name: "git" },
          { kind: "segment", name: "context" },
        ],
      },
      globals: { padding: 0 },
    },

    // Verbose arrangement surfacing every segment that is declared but NOT in
    // the default root (gitPr, burnrate, speed, tokenSparkline — see each
    // segment's own "declared-but-opt-in" comment above) alongside the
    // default's own two rows, for a user who wants the full usage-monitor
    // picture rather than the quiet default. A third row carries the two
    // per-turn throughput segments, which read "—" between turns
    // ([LAW:no-silent-failure] on speed/tokenSparkline) rather than an empty
    // or stale row. Like `compact`, it carries no preset control of its own —
    // the global settings menu is spliced into every preset root and is the
    // one door back.
    verbose: {
      root: {
        kind: "container",
        direction: "vertical",
        children: [
          {
            kind: "container",
            direction: "horizontal",
            children: [
              { kind: "segment", name: "directory" },
              { kind: "segment", name: "gitaculous" },
              { kind: "segment", name: "gitPr" },
              { kind: "segment", name: "toolbar" },
            ],
          },
          {
            kind: "container",
            direction: "horizontal",
            children: [
              { kind: "segment", name: "model" },
              { kind: "segment", name: "context" },
              { kind: "segment", name: "cacheTimer" },
              { kind: "segment", name: "block" },
              { kind: "segment", name: "weekly" },
              { kind: "segment", name: "burnrate" },
            ],
          },
          {
            kind: "container",
            direction: "horizontal",
            children: [
              { kind: "segment", name: "speed" },
              { kind: "segment", name: "tokenSparkline" },
            ],
          },
        ],
      },
    },
  },

  // [LAW:one-source-of-truth] What edit mode LOOKS like, as config a user can
  // retune — the whole point of candybar-settings-ui-aok.5, whose predecessor
  // was renderer constants. Powerline chrome exists to make adjacent segments
  // read as one continuous strip, which is precisely the wrong signal while a
  // user is trying to see where one segment ends and the next begins; `plain`
  // trades the caps for a visible separator between every cell.
  //
  // The separator is stated rather than left to PlainJoiner's own default: this
  // fragment layers over the user's globals, so a config that set
  // `default_separator` for its own powerline bar would otherwise carry that
  // choice into edit mode, where the separator is the entire affordance. " | "
  // (not "│") because it must survive `charset: "ascii"` — the fragment does
  // not, and should not, know the terminal's glyph coverage.
  editGlobals: {
    style: "plain",
    default_separator: " | ",
  },

  // [LAW:single-enforcer] / [LAW:one-source-of-truth] Display-formatting policy
  // for the cost/token/budget family lives here as named template helpers, each
  // DEFINED ONCE and called from every segment via `{{ template "name" .arg }}`
  // — so how a cost/token string looks is data a user overrides by name, not
  // compiled JS. The K/M token-scale rule has a SINGLE home (`formatTokenCount`);
  // `formatTokens` suffixes " tokens" onto it and `formatTokenBreakdown` calls it
  // per part, so the scale policy can never drift between the three.
  // [LAW:dataflow-not-control-flow] A multi-input helper (budgetStatus,
  // formatTokenBreakdown) receives its inputs as one `dict` value through its
  // single dot arg — variability flows as data across one boundary, not as a
  // bespoke multi-arg signature.
  helpers: {
    // Cost: under a cent reads "<$0.01"; otherwise "$" + two decimals. (Null is
    // unrepresentable through the var-system — type:number with a numeric default
    // owns "missing" upstream — so no null branch is needed here.)
    formatCost:
      '{{ if lt . 0.01 }}<$0.01{{ else }}${{ printf "%.2f" . }}{{ end }}',
    // The single home of the K/M token-scale rule. >=1e6 → "X.YM", >=1e3 → "X.YK",
    // else the integer verbatim (0 and negatives fall through to this arm, exactly
    // as the retired JS did). No " tokens" suffix — that is formatTokens' job.
    formatTokenCount:
      '{{ if ge . 1000000 }}{{ printf "%.1f" (divf . 1000000) }}M' +
      '{{ else if ge . 1000 }}{{ printf "%.1f" (divf . 1000) }}K' +
      "{{ else }}{{ . }}{{ end }}",
    formatTokens: '{{ template "formatTokenCount" . }} tokens',
    // Burn rate: "$X.XX/hr" when projectable, "—/hr" otherwise. The daemon
    // emits -1 (a structurally-impossible rate) for not-projectable, so the
    // branch reads a VALUE, never a hidden control-flow flag. Reuses formatCost
    // so the dollar policy has one home.
    formatRate:
      '{{ if lt . 0 }}—/hr{{ else }}{{ template "formatCost" . }}/hr{{ end }}',
    // ETA to a rate-limit cap: humanized minutes when projectable, "—" when the
    // daemon could not project (-1 sentinel). Reuses the long-remaining cascade.
    formatEta:
      '{{ if lt . 0 }}—{{ else }}{{ template "formatLongTimeRemaining" . }}{{ end }}',
    // Token throughput: "N/s" (K/M-scaled, rounded) when measured (>= 0), "—"
    // when the daemon had no projectable sample (-1). Branches on the VALUE, like
    // formatRate; reuses formatTokenCount so the K/M scale policy has one home.
    formatSpeed:
      '{{ if lt . 0 }}—{{ else }}{{ template "formatTokenCount" (round .) }}/s{{ end }}',
    // Breakdown over a dict {input, output, cacheCreation, cacheRead}; each present
    // part is formatted by the shared formatTokenCount and joined with " + ". A
    // `$first` flag (reassigned across if-frames) inserts the separator before all
    // but the first present part; all-zero collapses to "0 tokens".
    formatTokenBreakdown:
      "{{ $first := true }}" +
      '{{ if gt .input 0 }}{{ template "formatTokenCount" .input }} in{{ $first = false }}{{ end }}' +
      '{{ if gt .output 0 }}{{ if not $first }} + {{ end }}{{ template "formatTokenCount" .output }} out{{ $first = false }}{{ end }}' +
      '{{ if or (gt .cacheCreation 0) (gt .cacheRead 0) }}{{ if not $first }} + {{ end }}{{ template "formatTokenCount" (add .cacheCreation .cacheRead) }} cached{{ $first = false }}{{ end }}' +
      "{{ if $first }}0 tokens{{ end }}",
    // Budget suffix over a dict {cost, budget, warn}. Non-displayable (budget<=0 or
    // cost<0) → "". Otherwise pct = min(100, cost/budget*100), rendered " !N%" at/above
    // warn, " +N%" at/above 50, " N%" below.
    budgetStatus:
      "{{ if or (le .budget 0) (lt .cost 0) }}{{ else }}" +
      "{{ $pct := minf 100 (mulf (divf .cost .budget) 100) }}" +
      '{{ $p := printf "%.0f%%" $pct }}' +
      "{{ if ge $pct .warn }} !{{ $p }}" +
      "{{ else }}{{ if ge $pct 50 }} +{{ $p }}{{ else }} {{ $p }}{{ end }}{{ end }}" +
      "{{ end }}",

    // ─── Duration / time-remaining family (bdi.4) ──────────────────────────
    // Display policy for elapsed/remaining times, each DEFINED ONCE and called
    // from every segment via `{{ template "name" .x }}`. Input domain is a
    // non-negative number (seconds, or minutes for formatLongTimeRemaining); the
    // var-system owns "missing" as a numeric default upstream, so no null arm.
    //
    // The cascades branch on the VALUE (which unit threshold it falls in), never
    // on control flow [LAW:dataflow-not-control-flow]. `div`/`mod` are Go int64
    // (truncate toward zero == Math.floor for the non-negative domain); `printf
    // "%.Nf"` is the toFixed(N) stand-in (rounds, matching JS toFixed).

    // Compact "since" stamp: <1m → "Ns"; then floored m/h/d/w. `div` truncates
    // exactly like Math.floor here (seconds ≥ 0). Used by the git segment's
    // time-since-commit affordance — verbatim seconds under a minute.
    formatTimeSince:
      "{{ if lt . 60 }}{{ . }}s" +
      "{{ else if lt . 3600 }}{{ div . 60 }}m" +
      "{{ else if lt . 86400 }}{{ div . 3600 }}h" +
      "{{ else if lt . 604800 }}{{ div . 86400 }}d" +
      "{{ else }}{{ div . 604800 }}w{{ end }}",
    // Elapsed duration: <1m toFixed(0)+s; <1h (/60).toFixed(0)+m; <1d
    // (/3600).toFixed(1)+h; else (/86400).toFixed(1)+d. printf rounds (not
    // truncates), reproducing toFixed.
    formatDuration:
      '{{ if lt . 60 }}{{ printf "%.0f" . }}s' +
      '{{ else if lt . 3600 }}{{ printf "%.0f" (divf . 60) }}m' +
      '{{ else if lt . 86400 }}{{ printf "%.1f" (divf . 3600) }}h' +
      '{{ else }}{{ printf "%.1f" (divf . 86400) }}d{{ end }}',
    // Response time: one-decimal seconds under a minute, else one-decimal
    // minutes.
    formatResponseTime:
      '{{ if lt . 60 }}{{ printf "%.1f" . }}s' +
      '{{ else }}{{ printf "%.1f" (divf . 60) }}m{{ end }}',
    // Long remaining (input = whole minutes): ≥1day → "Nd"/"Nd Nh"; ≥1hour →
    // "Nh"/"Nh Nm"; else "Nm". The lower unit is appended only when non-zero,
    // matching the JS hours>0/minutes>0 guards. `$d`/`$h`/`$m` declared in the
    // branch frame and read by the inner if (lexical scope reads enclosing
    // frames) — go-template-js cannot capture a value any other way.
    formatLongTimeRemaining:
      "{{ if ge . 1440 }}{{ $d := div . 1440 }}{{ $h := div (mod . 1440) 60 }}" +
      "{{ if gt $h 0 }}{{ $d }}d {{ $h }}h{{ else }}{{ $d }}d{{ end }}" +
      "{{ else if ge . 60 }}{{ $h := div . 60 }}{{ $m := mod . 60 }}" +
      "{{ if gt $m 0 }}{{ $h }}h {{ $m }}m{{ else }}{{ $h }}h{{ end }}" +
      "{{ else }}{{ . }}m{{ end }}",
  },
} satisfies DslConfig;

// [LAW:locality-or-seam] The palette names this module-level parse is allowed
// to accept — DERIVED from RAW_DEFAULT_DSL_CONFIG itself (globals.palette +
// every per-segment palette: pin), never from the live theme registry
// (listResolvablePaletteNames()). A real user file must validate against the
// live registry (an author can type any name); this file validates against
// ITSELF (every name here is a literal we wrote and every render test below
// exercises against the real registry already). This is what keeps the
// module-load parse below from ever depending on the registry being healthy
// at import time — a registry-loading bug elsewhere would surface where it
// actually matters (a real render failing), never as an uncatchable crash on
// every importer of this file before any daemon/CLI error handling runs.
const AUTHORED_PALETTE_NAMES = new Set(
  [
    RAW_DEFAULT_DSL_CONFIG.globals.palette,
    ...(Object.values(RAW_DEFAULT_DSL_CONFIG.segments) as SegmentDecl[]).map(
      (s) => s.palette,
    ),
  ].filter((name): name is string => name !== undefined),
);

// [LAW:single-enforcer] Run the authored literal through the SAME
// parse → synthesize pipeline every user config goes through (JSON5 stage +
// synthesizeMenuDecls' `menus.*` synthesis, and any future group/menu
// synthesis pass) instead of hand-duplicating that logic here. Without this,
// the zero-config daemon path (loadConfig: no config file found ⇒ raw={},
// merged directly against this constant — see src/config/dsl-loader.ts and
// src/config/loader/merge.ts) would ship an UNSYNTHESIZED default: a
// `{{ menu (dict "key" …) }}` accordion pairing (the settings menu's pickers,
// brandon-theming-8uj.1) would render its glyph, but clicking it would reject
// with "unknown state key" — the synthesis that derives a menu's `menus.*`
// state var + cycle action only ever ran over TEXT a user typed, never over
// this TS literal. Round-tripping through JSON is exactly what
// test/default-dsl-config.test.ts's SERIALIZED-based tests already exercise,
// so this is the same well-tested path, run once here instead of skipped.
export const DEFAULT_DSL_CONFIG: DslConfig = mergeWithDefault(
  parseDslConfig(
    "<default>",
    JSON.stringify(RAW_DEFAULT_DSL_CONFIG),
    AUTHORED_PALETTE_NAMES,
  ),
  RAW_DEFAULT_DSL_CONFIG,
);
