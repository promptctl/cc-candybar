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

import type { DslConfig, SegmentDecl, SettingDecl } from "./dsl-types.js";
import { parseDslConfig } from "./dsl-loader.js";
import { mergeWithDefault } from "./loader/merge.js";
import { IN_TMUX, PAYLOAD_INPUTS } from "./payload-inputs.js";
import { quickActions } from "./quick-actions.js";
import { commandTray } from "./command-tray.js";
import { AUTOCOMPACT_WINDOWS } from "../segments/autocompact.js";
import { slashLine } from "../claude-input/slash-line.js";
// [LAW:one-source-of-truth] The contrast floor coloured text is held to is the
// same one the renderer holds chosen text to (textOn).
import { TEXT_MIN_CONTRAST } from "../themes/decor.js";
import { QUIET_TEXT } from "./quiet-text.js";

// The bundled `commands` segment's instance, under names no user config
// spells by accident.
const COMMAND_TRAY = commandTray("commands.");

// ─── Shared template fragments ───────────────────────────────────────────────
//
// Factored out of the segments' `template` fields where a TypeScript value is
// the only way to share one string between several fields.

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

// How far the two git segments' *structural* text — labels, punctuation,
// brackets, the sha, the upstream name, the elapsed-time annotation — sits
// toward their own background, as a percentage. It is applied as the segments'
// `fg:`, so structural text is simply what a token renders as when the
// template does NOT paint it; only the operative facts (branch, counts,
// status) name a color. [LAW:dataflow-not-control-flow] — the quiet case is
// the default that always applies, not a wrapper each token opts into. That
// inversion is why these templates carry no de-emphasis markup at all.
//
// The recipe and its measured floor are `QUIET_TEXT` (src/config/quiet-text.ts).
const GIT_QUIET_FG = `{{ ${QUIET_TEXT} }}`;

// [LAW:dataflow-not-control-flow] Every threshold cascade below is one
// `ramp <value> "step" <at> <colour> …` call (rich-js `paletteFuncs`): the
// value flows through ascending stops and the cell wears the last stop it
// passed, so "≥ threshold → hotter" is data, not an `if` chain, and the
// colour transposes with the palette and look like any `color`. The
// thresholds stay var refs a user overrides through the variables-merge-
// by-name cascade in mergeWithDefault; a threshold set below its neighbour
// is a loud render error (stops must ascend — the segment shows ⚠ and
// `cc-candybar check` fails), never a silently reordered cascade.
//
// The calm arm of every cascade is `(tint)`, the decoration the cell's address
// was dealt: a calm cell states nothing, so it wears what every cell that
// states nothing wears, and calm neighbours differ as decorated neighbours do.
// A fixed role here (`panel`) painted the calm block and weekly as one slab
// (brandon-theme-picker-bgw.8fp).
//
// block/weekly heat as the displayed (rounded) percentage rises: calm below
// `warnAt`, warning from it, error from `errorAt`. No `fg:` rides beside the
// ramp: the text is chosen on whichever stop the cell resolves to (`textOn`),
// so it cannot disagree with the background about where the cell warms.
//
// [LAW:types-are-the-program] Every threshold and budget is a SETTING of the
// placement (brandon-settings-coverage-g4p.lx2), so each copy tunes its own
// from configure mode, and a ramp's ascending stops are declared as an
// `atLeast` relation between them: a pick that would put them out of order is
// refused where it is written, and a file that does fails to load.
const PERCENT = { min: 0, max: 100, step: 5 } as const;

const QUOTA_SETTINGS: Readonly<Record<string, SettingDecl>> = {
  warnAt: { label: "warning at %", domain: PERCENT, default: 50 },
  errorAt: {
    label: "error at %",
    domain: { ...PERCENT, atLeast: "warnAt" },
    default: 80,
  },
};

function budgetSettings(budget: number): Readonly<Record<string, SettingDecl>> {
  return {
    budget: {
      label: "budget $",
      domain: { min: 0, max: 10000, step: 5 },
      default: budget,
    },
    warnAt: { label: "warning at %", domain: PERCENT, default: 80 },
  };
}

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
    ...COMMAND_TRAY.variables,
    // [LAW:one-source-of-truth] The payload inputs the synthesized settings
    // menu and edit chrome read, spelled once in payload-inputs.ts.
    ...PAYLOAD_INPUTS,
    // From hookData, pass-through.
    current_dir: {
      kind: "input",
      path: "workspace.current_dir",
      default: "?",
    },
    "model.display_name": {
      kind: "input",
      path: "model.display_name",
      default: "",
    },
    version: { kind: "input", path: "version", default: "" },

    // home flows through the augmented payload (buildRenderPayload reads
    // HOME, falling back to USERPROFILE on Windows where HOME is often
    // unset). Sourcing via `kind: "input"` rather than `kind: "env",
    // name: "HOME"` makes the directory `~` collapse work on every
    // platform without per-platform config edits.
    home: { kind: "input", path: "home", default: "" },

    // The tmux session name of the pane this session's client reported flows
    // through the daemon's augmented payload (TmuxService asks at most once
    // per pane per 30 s, so this stays cheap; `tmux.pane` itself is in
    // PAYLOAD_INPUTS). A `kind: "shell"` declaration would
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
    // The palette role each git fact is painted in — data a user overrides one
    // fact at a time (`"git.color.behind": { kind: "literal", value: "error" }`).
    // staged/ahead are `success` (ready to commit / unpushed work),
    // unstaged/behind `warning` (needs attention), untracked/stash `accent`
    // (told apart from unstaged by glyph, not colour), conflicts `error`.
    "git.color.branch": { kind: "literal", value: "primary" },
    "git.color.staged": { kind: "literal", value: "success" },
    "git.color.unstaged": { kind: "literal", value: "warning" },
    "git.color.untracked": { kind: "literal", value: "accent" },
    "git.color.conflicts": { kind: "literal", value: "error" },
    "git.color.ahead": { kind: "literal", value: "success" },
    "git.color.behind": { kind: "literal", value: "warning" },
    "git.color.stash": { kind: "literal", value: "accent" },
    // Which of its two forms `gitaculous` shows — per session, flipped by the
    // arrow at its right edge (the `gitDetail` action). The default is the form
    // every session starts in: redeclare this variable with
    // `default: "expanded"` to start with the full line.
    "git.detail": { kind: "state", key: "git-detail", default: "collapsed" },

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

    // The memento plugin's context ceiling for this session — the daemon asks
    // memento's own module for it (src/memento/edge.ts). ceiling -1 (default)
    // ⇒ memento is not installed for this project ⇒ the `ceiling` segment's
    // `when` hides it. `off` ⇒ a layer lifted the ceiling (ceiling reads 0).
    // `session` is the session's own layer as written, "" when it has none.
    // [LAW:no-silent-failure] `error` is memento's refusal — an unreadable
    // layer, the state in which memento's own gate has stopped for this
    // session — and the only field set when it is.
    "memento.ceiling": {
      kind: "input",
      path: "memento.ceiling",
      type: "number",
      default: -1,
    },
    "memento.off": {
      kind: "input",
      path: "memento.off",
      type: "boolean",
      default: false,
    },
    "memento.session": { kind: "input", path: "memento.session", default: "" },
    "memento.error": { kind: "input", path: "memento.error", default: "" },

    // Claude Code's auto-compact window as its `/autocompact` last wrote it
    // (src/segments/autocompact.ts, autoCompactControls): `window` in tokens,
    // 0 under `auto`, -1 (default) ⇒ not read; `applied` is that window capped
    // to the model's context window; `lower`/`higher` are the windows − and +
    // type, 0 where there is none. [LAW:no-silent-failure] `error` is the
    // settings file the daemon could not read, and the only field set when it
    // is.
    "autocompact.window": {
      kind: "input",
      path: "autocompact.window",
      type: "number",
      default: -1,
    },
    ...Object.fromEntries(
      ["applied", "lower", "higher"].map((field) => [
        `autocompact.${field}`,
        {
          kind: "input",
          path: `autocompact.${field}`,
          type: "number",
          default: 0,
        },
      ]),
    ),
    "autocompact.error": {
      kind: "input",
      path: "autocompact.error",
      default: "",
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

    // Activity — daemon fetches via ActivityProvider (brandon-activity-ue7).
    // The one non-quantity family: what Claude is DOING rather than how much of
    // it there has been. Every field is absent in the payload when there is
    // nothing real to say, so these defaults are also the "nothing happening"
    // reading the `when` gates test.
    "activity.command": {
      kind: "input",
      path: "activity.command",
      type: "string",
      default: "",
    },
    "activity.todo.total": {
      kind: "input",
      path: "activity.todo.total",
      type: "number",
      default: 0,
    },
    "activity.todo.completed": {
      kind: "input",
      path: "activity.todo.completed",
      type: "number",
      default: 0,
    },
    "activity.todo.position": {
      kind: "input",
      path: "activity.todo.position",
      type: "number",
      default: 0,
    },
    "activity.todo.active": {
      kind: "input",
      path: "activity.todo.active",
      type: "string",
      default: "",
    },
    // `"Bash:3,Read:1"` — tools by name and count; `formatToolTally` reads it
    // back. Note there is deliberately NO variable named `activity.todo` or
    // `activity.tool`: a scalar at a prefix would shadow every leaf under it.
    "activity.tool.running": {
      kind: "input",
      path: "activity.tool.running",
      type: "string",
      default: "",
    },
    "activity.tool.done": {
      kind: "input",
      path: "activity.tool.done",
      type: "string",
      default: "",
    },

    // No page-cursor var: a {{ menu }} synthesizes its own page
    // cursor (state var + int action, named by menuPageKey) under the reserved
    // menus.* namespace, alongside its open-state.
  },

  // ─── Segments ──────────────────────────────────────────────────────────────
  // Every built-in. Templates ported from the parity bindings; `fg:` (and the
  // few `bg:`) are palette spec names resolved against the active theme.
  //
  // [LAW:dataflow-not-control-flow] A segment authors a `bg:` only when the
  // colour STATES something — a threshold (context/block/weekly/burnrate) or
  // an alert (host). Every other cell wears the vocabulary tint its address
  // selects (src/themes/decor.ts, candybar-render-ai7.5); naming `surface` /
  // `panel` / `surface-active` for looks alone was hand-curated variety, and
  // the theme now supplies variety by position. `when` predicates
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
      group: "location",
      description:
        "The current directory, shortened fish-style — `~` under home, project-relative inside the project.",
      template: DIR_TEMPLATE,
    },
    model: {
      group: "model-context",
      description: "The active model's display name.",
      template: "✱ {{ formatModelName .model.display_name }}",
      when: '{{ ne .model.display_name "" }}',
    },
    sessionId: {
      group: "session-tools",
      description: "The session id, truncated to 8 characters.",
      template: "⌗{{ trunc 8 .session.id }}",
      when: '{{ ne .session.id "" }}',
    },
    version: {
      group: "model-context",
      description: "The Claude Code version reported in the hook payload.",
      template: "◈ v{{ .version }}",
      when: '{{ ne .version "" }}',
    },
    tmux: {
      group: "location",
      description: "The tmux session name; hidden when not inside tmux.",
      template: 'tmux:{{ .tmux.session | default "none" }}',
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
    // hue-ANCHORED palette roots, so it survives every theme and style still
    // reading as an alert. Any other slot could land camouflaged against its
    // neighbours — exactly what a "wrong machine" warning must never do.
    // No `fg:`: the text is chosen on whatever that resolves to, like every
    // unauthored cell's, rather than betting a fixed `foreground` stays legible.
    //
    // Each half falls back to "?" so a failed hostname/username read renders
    // `⇄ ?@?` — still unmistakably "remote", and legibly missing its identity
    // rather than a blank that reads as a rendering bug ([LAW:no-silent-failure]).
    host: {
      group: "location",
      description: "user@host on a warning background, shown only over SSH.",
      template:
        '⇄ {{ .host.user | default "?" }}@{{ .host.name | default "?" }}',
      bg: "warning",
      when: "{{ .host.ssh }}",
    },
    // [LAW:one-source-of-truth] One git segment, two forms: `gitCollapsed` (the
    // summary) and `gitExpanded` (every fact), each a composition of the named
    // `git*` pieces below, so a fact has one spelling and one colour in both
    // forms, and a user reshapes either by overriding one piece, one form, or
    // one `git.color.*` variable. The arrow is the segment's last cell content:
    // a `cycle` action over the session's `git.detail`, so each Claude session
    // keeps its own choice — nothing here a user config cannot also write.
    // Everything no piece paints — the "(git)" label, repo name, brackets, sha,
    // the elapsed-time annotation, the arrow — renders in the quiet `fg:`
    // below, a template evaluating to a colour: `bgOf` is available there
    // because a segment's background is resolved before its foreground, so
    // structural text sits a fixed distance from THIS cell whatever theme or
    // style is in effect, and the eye lands on the painted facts first.
    gitaculous: {
      group: "git",
      description:
        "The git state: a summary (branch, ahead/behind, S/U/? flags) that the arrow at its right edge expands to every fact — repo, in-progress operation, sha, upstream ±, stash count, time since the last commit.",
      template:
        '{{ if eq .git.detail "expanded" }}{{ template "gitExpanded" . }}' +
        '{{ else }}{{ template "gitCollapsed" . }}{{ end }}' +
        ' {{ action "gitDetail" "▸" "◂" }}',
      fg: GIT_QUIET_FG,
      when: '{{ ne .git.branch "" }}',
      // [LAW:dataflow-not-control-flow] Which optional facts THIS copy shows
      // (brandon-segment-settings-i4n.u36): each is read by its own piece
      // below, so a fact leaves both forms at once, the same as overriding
      // the piece with an empty body does, but per placement and from the bar.
      settings: {
        aheadBehind: { label: "ahead/behind", domain: "bool", default: true },
        flags: { label: "dirty flags", domain: "bool", default: true },
        operation: { label: "operation", domain: "bool", default: true },
        repo: { label: "repo name", domain: "bool", default: true },
        sha: { label: "commit hash", domain: "bool", default: true },
        stash: { label: "stash", domain: "bool", default: true },
        upstream: { label: "upstream", domain: "bool", default: true },
        age: { label: "time since commit", domain: "bool", default: true },
      },
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
      group: "git",
      description:
        "The pull request open for this branch, as a link; `⚠ PR` when the forge lookup failed.",
      // The pad spaces are structural chrome now, OUTSIDE the OSC-8 link
      // region — the clickable area is the glyph text itself.
      template:
        '{{ if ne .git.prUrl "" }}' +
        '{{ link .git.prUrl (printf "⇆ #%v" .git.prNumber) }}' +
        "{{ else }}⚠ PR{{ end }}",
      when: '{{ or (ne .git.prUrl "") (ne .git.prError "") }}',
    },
    toolbar: {
      group: "session-tools",
      description:
        "Quick actions: copy the session id, and open the project, transcript or repo.",
      template: quickActions("").template,
    },
    // OPT-IN, like `toolbar`: the settings menu carries its own instance.
    commands: {
      group: "session-tools",
      description:
        "Type /compact, /model or /clear into this session; /clear asks for a second click. Hidden when not inside tmux.",
      template: COMMAND_TRAY.template,
      when: COMMAND_TRAY.when,
    },
    // Declared-but-opt-in: a theme stepper that lives ON the bar — one click
    // per theme, with no menu to open (brandon-theme-picker-bgw.exj).
    // Kept out of the bundled rows because every setting lives behind the
    // door by default; place it by naming it in a row.
    //
    // [LAW:one-type-per-behavior] Not a second theme picker: it is the
    // settings menu's own `{{ carousel }}` asked for zero neighbours, over a
    // plain `{ set: "theme", from: "themes" }` — the session key the menu's
    // theme control writes unsaved, read back through `theme.effective` (the
    // theme the bar wears), so the two can never disagree about the current
    // theme. Nothing here a user config could not author itself.
    themeSwitcher: {
      group: "session-tools",
      description:
        "`◀ <theme> ▶`: the theme the bar is wearing; ◀ and ▶ switch this session to the previous or next theme, wrapping at the ends.",
      template: '{{ carousel "stepTheme" 0 }}',
    },
    session: {
      group: "cost-limits",
      description:
        "This session's cost and token total, with a budget warning once a budget is configured.",
      template:
        '§ {{ template "formatCost" .session.cost }} ({{ template "formatTokens" .session.tokens }})' +
        '{{ template "budgetStatus" (dict "cost" .session.cost "budget" .settings.budget "warn" .settings.warnAt) }}',
      // [LAW:dataflow-not-control-flow] A budget of 0 is budgetStatus's
      // non-displayable value, so a placement with no budget renders no
      // suffix through the same unconditional template — opt-in is a value.
      settings: budgetSettings(0),
    },
    today: {
      group: "cost-limits",
      description:
        "Today's cost and tokens across every session, with a budget warning once a budget is configured.",
      template:
        '☉ {{ template "formatCost" .today.cost }} ({{ template "formatTokens" .today.tokens }})' +
        '{{ template "budgetStatus" (dict "cost" .today.cost "budget" .settings.budget "warn" .settings.warnAt) }}',
      settings: budgetSettings(50),
    },
    block: {
      group: "cost-limits",
      description:
        "The 5-hour rate-limit block: percent used and time to reset, heating to warning then error.",
      template:
        "◱ {{ round .block.nativeUtilization }}% " +
        '({{ template "formatResetCountdown" .block.resetsAt }})',
      bg: '{{ ramp (round .block.nativeUtilization) "step" 0 (tint) .settings.warnAt "warning" .settings.errorAt "error" }}',
      settings: QUOTA_SETTINGS,
      // No `fg:`: an unauthored foreground is the theme pole that reads on the
      // background this ramp resolves to, at every stop. The hand-paired
      // `button-color-foreground` it replaces measured 1.55:1 on rose-pine's
      // warning (brandon-theme-picker-bgw.b2g).
      // Hide unless we have a five-hour-window snapshot.
      when: "{{ gt .block.resetsAt 0 }}",
    },
    weekly: {
      group: "cost-limits",
      description:
        "The weekly rate-limit quota: percent used and time to reset, heating to warning then error.",
      template:
        "◑ {{ round .weekly.percentage }}% " +
        '({{ template "formatResetCountdown" .weekly.resetsAt }})',
      bg: '{{ ramp (round .weekly.percentage) "step" 0 (tint) .settings.warnAt "warning" .settings.errorAt "error" }}',
      settings: QUOTA_SETTINGS,
      when: "{{ gt .weekly.resetsAt 0 }}",
    },
    // Burn rate + cap projection: "$X/hr · Nm to 5h · Nd to wk". The headline
    // number of a usage monitor — how fast you are spending and when you hit
    // the wall. All math is daemon-side (render-payload.ts); the template only
    // formats. Heats as the 5h cap NEARS — the ramp runs over minutes-to-cap,
    // smaller = hotter, the inverse of block's fuller-is-hotter — and the -1
    // "cannot project" sentinel sits calm at the first stop. Shown when either
    // rate-limit window is active — the same signal block/weekly gate on.
    burnrate: {
      group: "cost-limits",
      description:
        "Spend per hour, with the projected time to the 5-hour and weekly limits.",
      template:
        '⚡ {{ template "formatRate" .burn.costPerHour }} · ' +
        '{{ template "formatEta" .block.etaMinutes }} to 5h · ' +
        '{{ template "formatEta" .weekly.etaMinutes }} to wk',
      bg: '{{ ramp .block.etaMinutes "step" -1 (tint) 0 "error" .settings.errorWithin "warning" .settings.warnWithin (tint) }}',
      // Minutes to the 5h cap, so the nearer threshold is the hotter one:
      // error inside `errorWithin`, warning inside `warnWithin`.
      settings: {
        errorWithin: {
          label: "error within (min)",
          domain: { min: 0, max: 300, step: 5 },
          default: 30,
        },
        warnWithin: {
          label: "warning within (min)",
          domain: { min: 0, max: 300, step: 5, atLeast: "errorWithin" },
          default: 60,
        },
      },
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
      group: "activity",
      description:
        "Token throughput for the latest exchange: output, input, and total.",
      template:
        '⇅ out {{ template "formatSpeed" .speed.output }} · ' +
        'in {{ template "formatSpeed" .speed.input }} · ' +
        'tot {{ template "formatSpeed" .speed.total }}',
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
      group: "activity",
      description: "A sparkline of recent token throughput.",
      template: "⚡ {{ sparkline .speed.history 24 }}",
      when: '{{ ne .speed.history "" }}',
    },
    // Prompt-cache warmth countdown. minutesUntilReset clamps a past expiry
    // to 0, so an expired cache renders "cold" (and reads red via the ≤8
    // arm) rather than a negative number. [LAW:dataflow-not-control-flow]
    // glyph + "cold"/"Nm" + color all derive from the one expiry value; the
    // provider supplies no display state. No `bg:` — the cell keeps its
    // vocabulary tint and the threshold rides the fg alone, mirroring the
    // legacy inline-colored text (warm = normal, ≤20m = warning, ≤8m/cold =
    // error).
    cacheTimer: {
      group: "activity",
      description:
        "Minutes until the prompt cache expires, or `cold` once it has.",
      template:
        "◴ {{ if le (minutesUntilReset .cache.expiresAt) 0 }}cold" +
        "{{ else }}{{ minutesUntilReset .cache.expiresAt }}m{{ end }}",
      // brandon-template-funcs-jku: this was a three-level `if` chain over the same
      // value, which is a threshold cascade that could not be read as one. `cascade`
      // is `ramp`'s decision with a text result, so the thresholds are visible as
      // numbers here the way the block/weekly `bg:` cascades are. The bands are the
      // chain's own: <= 8 error, <= 20 warning, above that foreground
      // (test/cascade.test.ts pins the two against each other at every boundary).
      // The cascade picks the role; the floor keeps it legible on this cell's
      // tint, exactly as a git accent is (`accent` above).
      fg:
        '{{ readableOn (color (cascade (minutesUntilReset .cache.expiresAt) "0:error" ' +
        `"9:warning" "21:foreground")) (bgOf) ${TEXT_MIN_CONTRAST} }}`,
      when: "{{ gt .cache.expiresAt 0 }}",
    },
    context: {
      group: "model-context",
      description:
        "Context used, in tokens and percent remaining, heating as it fills.",
      template:
        "◔ {{ formatInteger .context.totalTokens }} ({{ .context.contextLeft }}%)",
      // contextLeft is an integer (src/segments/context.ts rounds it), so the
      // "≤ 20 / ≤ 40" edges are the stops at 21 and 41 exactly.
      bg: '{{ ramp .context.contextLeft "step" 0 "error" 21 "warning" 41 (tint) }}',
      when: "{{ gt .context.totalTokens 0 }}",
    },
    // Beside `context` wherever it stands, since the two numbers are read
    // against each other: how full the context is, and where memento will ask
    // the session to hand off. The controls move this session's own layer —
    // memento's `ceiling set session` — and `↺` appears only while there is
    // one to clear, or while a refusal may be that layer's own (clearing a
    // layer memento cannot read restores its gate). Absent when memento is
    // not installed, or Claude Code has it disabled.
    ceiling: {
      group: "model-context",
      description:
        "The memento plugin's context ceiling for this session: − and + move it by 100K, ∞ lifts it, ↺ drops this session's own setting.",
      template:
        '{{ if ne .memento.error "" }}⌈ ⚠ {{ .memento.error }} {{ action "ceiling.clear" "↺" }}{{ else }}⌈ ' +
        '{{ if .memento.off }}off{{ else }}{{ template "formatTokenCount" .memento.ceiling }} ' +
        '{{ action "ceiling.lower" "−" }} {{ action "ceiling.raise" "+" }} {{ action "ceiling.off" "∞" }}{{ end }}' +
        '{{ if ne .memento.session "" }} {{ action "ceiling.clear" "↺" }}{{ end }}{{ end }}',
      // [LAW:no-silent-failure] An unreadable layer paints `error`: memento's
      // gate is off for this session until someone fixes the file it names.
      bg: '{{ if ne .memento.error "" }}{{ color "error" }}{{ else }}{{ tint }}{{ end }}',
      when: '{{ or (ge .memento.ceiling 0) (ne .memento.error "") }}',
    },
    // Beside the ceiling: where Claude Code itself will summarize the context.
    // Claude Code's `/autocompact` is its only writer, so each control types
    // that command into the session (a `slash` action per window below); the
    // daemon names the window − and + land on (autoCompactControls), and ↺
    // hands the window back to `auto`.
    autocompact: {
      group: "model-context",
      description:
        "Claude Code's auto-compact window: − and + move it by 100K, ↺ returns it to auto. Clicks type /autocompact into this session, so the controls show only inside tmux.",
      template:
        '{{ if ne .autocompact.error "" }}⇲ ⚠ {{ .autocompact.error }}{{ else }}' +
        '⇲ {{ if eq .autocompact.window 0 }}auto{{ else }}{{ template "formatTokenCount" .autocompact.applied }}{{ end }}' +
        // The window reads anywhere; its controls show only where a click has
        // a pane to type into.
        `{{ if ${IN_TMUX} }}` +
        '{{ if gt .autocompact.lower 0 }} {{ action (printf "autocompact.%d" .autocompact.lower) "−" }}{{ end }}' +
        '{{ if gt .autocompact.higher 0 }} {{ action (printf "autocompact.%d" .autocompact.higher) "+" }}{{ end }}' +
        '{{ if gt .autocompact.window 0 }} {{ action "autocompact.auto" "↺" }}{{ end }}{{ end }}{{ end }}',
      bg: '{{ if ne .autocompact.error "" }}{{ color "error" }}{{ else }}{{ tint }}{{ end }}',
      when: '{{ or (ge .autocompact.window 0) (ne .autocompact.error "") }}',
    },
    metrics: {
      group: "activity",
      description:
        "Response times, session duration, message count, and lines added/removed.",
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
      // [LAW:no-silent-failure] Each arm is a BOOLEAN, not the value itself.
      // `evaluateWhen` hides a segment only on the literal text "false", so
      // `{{ or <numbers> }}` over all-zero fields renders "0" — visible, an empty
      // bg-styled cell, the exact outcome the paragraph above says this gate
      // prevents. Found while adding `activity`, which copied this shape
      // (brandon-activity-ue7).
      when:
        "{{ or (gt .metrics.lastResponseTime 0.0) (gt .metrics.responseTime 0.0)" +
        " (gt .metrics.sessionDuration 0.0) (gt .metrics.messageCount 0)" +
        " (gt .metrics.linesAdded 0) (gt .metrics.linesRemoved 0) }}",
    },
    // What Claude is doing right now (brandon-activity-ue7) — the only segment
    // on the bar whose content is not a quantity. Three parts, each gated on its
    // own value exactly as `metrics` is, and the whole cell gated off when the
    // session is idle, so a bar at rest is unchanged from before this existed.
    //
    // The todo part has two readings of one list: the in-progress item with its
    // position while there is one, and the completed-of-total tally when there is
    // not. `completed` (not `position`) is what distinguishes a finished list
    // from an all-pending one — `☑ 7/7` and `☑ 0/7` are both true statements.
    // `abbrev` bounds the task text, since an `activeForm` is a sentence.
    activity: {
      group: "activity",
      description:
        "What Claude is doing: the slash command that opened the turn, the in-progress todo, and the tools in flight.",
      template:
        "{{ if .activity.command }} ⌘ {{ .activity.command }}{{ end }}" +
        "{{ if .activity.todo.total }}" +
        "{{ if .activity.todo.active }} ☐ {{ .activity.todo.position }}/{{ .activity.todo.total }} {{ abbrev 32 .activity.todo.active }}" +
        "{{ else }} ☑ {{ .activity.todo.completed }}/{{ .activity.todo.total }}{{ end }}" +
        "{{ end }}" +
        '{{ if .activity.tool.running }} ⟳ {{ template "formatToolTally" .activity.tool.running }}{{ end }}' +
        '{{ if .activity.tool.done }} ✓ {{ template "formatToolTally" .activity.tool.done }}{{ end }} ',
      // Boolean arms, for the reason spelled on `metrics` above: a `when` is
      // hidden only by the literal text "false".
      when:
        '{{ or (ne .activity.command "") (gt .activity.todo.total 0)' +
        ' (ne .activity.tool.running "") (ne .activity.tool.done "") }}',
    },
  },

  // Default layout — the canonical Root: a map of NAMED rows (`satisfies
  // DslConfig` requires the lowered node form inside each row; the terse
  // Option-A `{ h/v/seg }` grammar is the loader's authoring surface for user
  // JSON, not this typed literal).
  //
  // [LAW:one-source-of-truth] The row NAMES are the merge keys. A user file's
  // `root: { rows: { status: { h: [...] } } }` replaces exactly the row it
  // names and inherits the other in place — the same by-name cascade every
  // other section merges with — and `status: { h: [] }` removes one. This
  // literal is read both as JSON (parsed like a user file) and as the typed
  // base it merges onto, so the canonical shape and the authoring shape are
  // one object by construction.
  //
  // Two always-visible rows: an IDENTITY row (where am I — the host, the
  // directory and the verbose `gitaculous` line) over a STATUS row (what's
  // happening now — model, context-window fill, prompt-cache warmth, and the
  // 5h / 7d rate-limit quotas). Every setting lives behind the settings-menu
  // door the loader leads the first row with (src/config/settings-menu.ts),
  // not on the bar. Each row zips its segments through the powerline joiner;
  // `\n` separates the rows.
  //
  // [LAW:dataflow-not-control-flow] Every status segment is when-gated on its
  // own signal (no repo → the identity row is just the directory; no
  // active rate-limit window → block/weekly drop; no cache activity → cacheTimer
  // drops). A row therefore only ever shows the segments that have real data —
  // the layout is chosen by the data, not by branches — so the default never
  // paints an empty or placeholder cell. The directory has no `when`, so row
  // 1 always anchors the bar.
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
        ],
      },
      status: {
        kind: "container",
        direction: "horizontal",
        children: [
          { kind: "segment", name: "model" },
          // One cell unit: the ceiling reads against the context use beside it,
          // and hidden (no memento) it takes no colour slot from the row.
          {
            kind: "container",
            direction: "horizontal",
            children: [
              { kind: "segment", name: "context" },
              { kind: "segment", name: "ceiling" },
              { kind: "segment", name: "autocompact" },
            ],
          },
          { kind: "segment", name: "cacheTimer" },
          { kind: "segment", name: "block" },
          { kind: "segment", name: "weekly" },
          // Last on the row on purpose: it is the most volatile cell on the bar
          // (it appears, changes width, and drops again within one turn), so
          // trailing it means nothing to its left ever reflows.
          { kind: "segment", name: "activity" },
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
    ...quickActions("").actions,
    ...COMMAND_TRAY.actions,
    copyDir: { copy: "{{ .current_dir }}" },
    // The `themeSwitcher` segment's click: each arrow writes the theme it
    // points at into this session. Gated by the themes domain it names, the
    // same allow-list the settings menu's theme control derives.
    stepTheme: { set: "theme", from: "themes" },
    // The `gitaculous` arrow: collapsed ↔ expanded, this session only.
    gitDetail: { set: "git-detail", cycle: ["collapsed", "expanded"] },
    // The `ceiling` segment's controls: memento's own value grammar, handed to
    // its `ceiling set session` (or `clear session`) for the clicked session.
    // These declarations are also the only moves the ceiling verb accepts.
    "ceiling.raise": { ceiling: "set", to: "+100_000" },
    "ceiling.lower": { ceiling: "set", to: "-100_000" },
    "ceiling.off": { ceiling: "set", to: "off" },
    "ceiling.clear": { ceiling: "clear" },
    // The `autocompact` segment's controls. [LAW:one-source-of-truth] One
    // action per window Claude Code accepts, so the lines a click can type are
    // exactly AUTOCOMPACT_WINDOWS; the segment picks one by name.
    "autocompact.auto": { slash: slashLine("/autocompact auto") },
    ...Object.fromEntries(
      AUTOCOMPACT_WINDOWS.map((w) => [
        `autocompact.${w}`,
        { slash: slashLine(`/autocompact ${w}`) },
      ]),
    ),
  },

  // ─── Styles ───────────────────────────────────────────────────────────────
  // Named theme ADAPTATIONS — each is a full rich-js ThemeKey applied on top
  // of whatever base theme is active (a transform, not a palette), so every
  // style composes with every theme: pick theme, then pick style. Selected per
  // session via the `style` SessionState key (an action `{ set: "style", from:
  // "styles" }` + a `{{ menu }}`), exactly the theme/endcaps selection seam.
  // [LAW:one-source-of-truth] Merges by name (user wins per name), so this
  // stdlib — including the "none" identity floor effectiveStyleName collapses
  // to — is present in every merged config by construction.
  styles: {
    // [LAW:dataflow-not-control-flow] "none" is just the identity style — the
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
  // configuration what a style is to a theme, and rides the identical seam:
  // selected per session via the `preset` SessionState key — or pinned as the
  // durable default via `globals.preset` — through the settings menu's preset
  // control and its save (src/config/settings-menu.ts), resolved as session
  // pick over globals.preset over this floor.
  // [LAW:one-source-of-truth] Merges by name (user wins per name), so this
  // stdlib is present in every merged config by construction, exactly as
  // styles' "none"/"vivid"/"muted"/… is — a user redefining "compact" or
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
    // is left), and `padding: 0` to buy back the chrome a narrow column can't
    // spare. `gitaculous` starts collapsed here as everywhere, so the git state
    // costs a narrow column only the summary until someone asks for more.
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
          { kind: "segment", name: "gitaculous" },
          { kind: "segment", name: "context" },
        ],
      },
      globals: { padding: 0 },
    },

    // Verbose arrangement surfacing four segments that are declared but NOT in
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
            ],
          },
          {
            kind: "container",
            direction: "horizontal",
            children: [
              { kind: "segment", name: "model" },
              {
                kind: "container",
                direction: "horizontal",
                children: [
                  { kind: "segment", name: "context" },
                  { kind: "segment", name: "ceiling" },
                  { kind: "segment", name: "autocompact" },
                ],
              },
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

    // For heads-down work where the bar should stay out of the way: one row,
    // only where you are and how much context is left, powerline chrome traded
    // for plain text and the whole bar receded under the `dim` style. It is the
    // quiet end of the library the way `verbose` is the loud one — `compact`
    // saves width, this saves attention.
    zen: {
      root: {
        kind: "container",
        direction: "horizontal",
        children: [
          { kind: "segment", name: "directory" },
          { kind: "segment", name: "context" },
        ],
      },
      globals: { endcaps: "plain", style: "dim" },
    },

    // For branch-and-PR work — juggling reviews, rebases, several branches:
    // the identity row gains the open PR (`gitPr`, which the default leaves
    // out) beside the git state, and the status row keeps only what that work
    // checks between pushes (model, context, what Claude is doing), dropping
    // the rate-limit windows that matter to a long solo session instead.
    git: {
      root: {
        kind: "container",
        direction: "vertical",
        children: [
          {
            kind: "container",
            direction: "horizontal",
            children: [
              { kind: "segment", name: "host" },
              { kind: "segment", name: "directory" },
              { kind: "segment", name: "gitaculous" },
              { kind: "segment", name: "gitPr" },
            ],
          },
          {
            kind: "container",
            direction: "horizontal",
            children: [
              { kind: "segment", name: "model" },
              { kind: "segment", name: "context" },
              { kind: "segment", name: "activity" },
            ],
          },
        ],
      },
    },

    // For watching spend and limits — a long session near a budget or a rate
    // limit: every cost and limit segment the bundled library declares, one
    // concern per row. Row 1 is this conversation (context, cache), row 2 the
    // rate-limit windows and how fast they are burning, row 3 money (this
    // session, today across every session) and throughput. It is the one
    // preset that stages `today`.
    usage: {
      root: {
        kind: "container",
        direction: "vertical",
        children: [
          {
            kind: "container",
            direction: "horizontal",
            children: [
              { kind: "segment", name: "model" },
              {
                kind: "container",
                direction: "horizontal",
                children: [
                  { kind: "segment", name: "context" },
                  { kind: "segment", name: "ceiling" },
                  { kind: "segment", name: "autocompact" },
                ],
              },
              { kind: "segment", name: "cacheTimer" },
            ],
          },
          {
            kind: "container",
            direction: "horizontal",
            children: [
              { kind: "segment", name: "block" },
              { kind: "segment", name: "weekly" },
              { kind: "segment", name: "burnrate" },
            ],
          },
          {
            kind: "container",
            direction: "horizontal",
            children: [
              { kind: "segment", name: "session" },
              { kind: "segment", name: "today" },
              { kind: "segment", name: "speed" },
              { kind: "segment", name: "tokenSparkline" },
            ],
          },
        ],
      },
    },

    // For a wide terminal that should give the bar as few lines as possible:
    // the default's two rows, plus spend, poured into ONE row with no padding,
    // which the width-based auto-wrap folds only where the terminal actually
    // runs out — so a wide window gets one line and a narrow one still gets
    // every segment. `activity` stays last for the same reason it does in the
    // default: it is the cell that reflows.
    dense: {
      root: {
        kind: "container",
        direction: "horizontal",
        children: [
          { kind: "segment", name: "host" },
          { kind: "segment", name: "directory" },
          { kind: "segment", name: "gitaculous" },
          { kind: "segment", name: "model" },
          {
            kind: "container",
            direction: "horizontal",
            children: [
              { kind: "segment", name: "context" },
              { kind: "segment", name: "ceiling" },
              { kind: "segment", name: "autocompact" },
            ],
          },
          { kind: "segment", name: "cacheTimer" },
          { kind: "segment", name: "block" },
          { kind: "segment", name: "weekly" },
          { kind: "segment", name: "session" },
          { kind: "segment", name: "activity" },
        ],
      },
      globals: { padding: 0 },
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
    endcaps: "plain",
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
    // Text in a palette colour, floored at TEXT_MIN_CONTRAST against the cell
    // it sits on: a theme's `success`/`warning`/`accent` is designed against
    // its own background, not the tint a bar cell wears (the raw role measured
    // 1.01:1 on `textual-light`, brandon-theme-picker-bgw.b2g). `readableOn` moves only
    // OKLCH lightness, so the hue — the part that says "staged" — survives.
    // Called with a dict: `(dict "color" <palette name or hex> "text" <text>)`.
    gitPaint: `{{ fg (readableOn (color .color) (bgOf) ${TEXT_MIN_CONTRAST}) .text }}`,

    // ─── Git forms and pieces ──────────────────────────────────────────────
    // The two forms `gitaculous` switches between, each composed of the pieces
    // below. Override one to change what that form shows.
    gitCollapsed:
      '{{ template "gitBranch" . }}{{ template "gitAheadBehind" . }}{{ template "gitFlags" . }}',
    gitExpanded:
      "(git)" +
      '{{ template "gitRepo" . }}' +
      '{{ template "gitOperation" . }}' +
      '{{ template "gitSha" . }}' +
      '{{ template "gitFlags" . }}' +
      ' {{ template "gitBranch" . }}' +
      '{{ template "gitUpstream" . }}' +
      '{{ template "gitStash" . }}' +
      '{{ template "gitAge" . }}',
    // The named parts the two forms compose, each called
    // with the root scope (`{{ template "gitFlags" . }}`). Every optional piece
    // renders ` <fact>` with its OWN leading space, or nothing — only the piece
    // knows whether it exists — so pieces reorder and drop without leaving a
    // doubled or dangling space. `gitBranch` is the exception: the segment is
    // gated on a branch, so it is always present and carries no space. A piece
    // whose fact is optional reads that fact's `.settings.<name>` too, so a
    // segment of your own that calls it declares the same setting (the loader
    // names that segment, the setting, and the helper when it does not).
    gitBranch:
      '⎇ {{ template "gitPaint" (dict "color" .git.color.branch "text" .git.branch) }}',
    gitRepo:
      '{{ if and .settings.repo (ne .git.repoName "") }} {{ .git.repoName }}{{ end }}',
    gitOperation:
      '{{ if and .settings.operation (ne .git.operation "") }} [{{ .git.operation }}]{{ end }}',
    gitSha:
      '{{ if and .settings.sha (ne .git.sha "") }} {{ .git.sha }}{{ end }}',
    gitFlags:
      "{{ if and .settings.flags (or (gt .git.staged 0) (gt .git.unstaged 0) (gt .git.untracked 0) (gt .git.conflicts 0)) }} " +
      '{{ if gt .git.staged 0 }}{{ template "gitPaint" (dict "color" .git.color.staged "text" "S") }}{{ end }}' +
      '{{ if gt .git.unstaged 0 }}{{ template "gitPaint" (dict "color" .git.color.unstaged "text" "U") }}{{ end }}' +
      '{{ if gt .git.untracked 0 }}{{ template "gitPaint" (dict "color" .git.color.untracked "text" "?") }}{{ end }}' +
      '{{ if gt .git.conflicts 0 }}{{ template "gitPaint" (dict "color" .git.color.conflicts "text" (printf "!%v" .git.conflicts)) }}{{ end }}' +
      "{{ end }}",
    gitAheadBehind:
      "{{ if and .settings.aheadBehind (or (gt .git.ahead 0) (gt .git.behind 0)) }} " +
      '{{ if gt .git.ahead 0 }}{{ template "gitPaint" (dict "color" .git.color.ahead "text" (printf "+%v" .git.ahead)) }}{{ end }}' +
      "{{ if and (gt .git.ahead 0) (gt .git.behind 0) }}/{{ end }}" +
      '{{ if gt .git.behind 0 }}{{ template "gitPaint" (dict "color" .git.color.behind "text" (printf "-%v" .git.behind)) }}{{ end }}' +
      "{{ end }}",
    gitUpstream:
      '{{ if and .settings.upstream (ne .git.upstream "") }} [{{ .git.upstream }}{{ template "gitAheadBehind" . }}]{{ end }}',
    gitStash:
      '{{ if and .settings.stash (gt .git.stash 0) }} {{ template "gitPaint" (dict "color" .git.color.stash "text" (printf "(%v stashed)" .git.stash)) }}{{ end }}',
    gitAge:
      '{{ if and .settings.age (gt .git.timeSinceCommit 0) }} ◷ {{ template "formatTimeSince" .git.timeSinceCommit }}{{ end }}',

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
    // A tool tally — `"Bash:3,Read:1"`, the payload's one encoding for both
    // running and completed tools — read back as `Bash×3 Read`, capped at the
    // first two names with a `+N` overflow for the rest. A count of 1 shows no
    // multiplier, so the common case reads as a plain tool name.
    // [LAW:one-source-of-truth] ONE helper for both fields, because the payload
    // gives them one shape; a second spelling would be a second policy for
    // "how a tool tally reads". The caller must gate on the value being
    // non-empty — an empty tally is absent in the payload, and `splitList` on ""
    // yields one positionless member.
    formatToolTally:
      '{{ $names := splitList "," . }}' +
      "{{ range $i, $pair := $names }}{{ if lt $i 2 }}" +
      '{{ if $i }} {{ end }}{{ $kv := splitList ":" $pair }}{{ index $kv 0 }}' +
      '{{ if ne (index $kv 1) "1" }}×{{ index $kv 1 }}{{ end }}' +
      "{{ end }}{{ end }}" +
      "{{ if gt (len $names) 2 }} +{{ sub (len $names) 2 }}{{ end }}",
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
    // Reset countdown (input = epoch seconds): the minute in progress counts,
    // so a reset seconds away reads "1m" and the bar never shows "0m" while
    // time remains. A uniform +1 over the rounded whole minutes, deliberately
    // not a floor at 1 — a floor is a special case on the last minute, and the
    // one bias reads the same at every distance. The block/weekly segments
    // are its only callers; the cacheTimer keeps the raw minutesUntilReset,
    // where 0 means cold.
    formatResetCountdown:
      '{{ template "formatLongTimeRemaining" (add 1 (minutesUntilReset .)) }}',
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

// [LAW:single-enforcer] Run the authored literal through the SAME parse
// pipeline every user config goes through (JSON5 stage + group synthesis and
// the parse-time checks) instead of hand-duplicating that logic here. Without
// this, the zero-config daemon path (loadConfig: no config file found ⇒
// raw={}, merged directly against this constant — see src/config/dsl-loader.ts
// and src/config/loader/merge.ts) would ship an UNSYNTHESIZED default: a
// synthesis that only ever ran over TEXT a user typed, never over this TS
// literal. Round-tripping through JSON is exactly what
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
