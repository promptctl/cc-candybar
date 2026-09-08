// [LAW:one-source-of-truth] The bundled default DslConfig — the statusline rendered when no config file is present.
// [LAW:single-enforcer] One default. User configs merge on top by name, so a file only declares what differs.
// [LAW:dataflow-not-control-flow] Every segment is declared regardless of what `root` includes; enabling one is a root edit.
// [LAW:types-are-the-program] `satisfies DslConfig` checks the authored literal; the export is that literal run through the loader's own synthesis.

import type { DslConfig, LayoutNode, SegmentDecl } from "./dsl-types.js";
import { parseDslConfig } from "./dsl-loader.js";
import {
  DISCLOSURE_GLYPH_CLOSED,
  DISCLOSURE_GLYPH_OPEN,
} from "./disclosure.js";
import { mergeWithDefault } from "./loader/merge.js";

// Prefix checks are boundary-safe: "under" means equal OR starting with `base + "/"`, so
// `/home/al` never matches `/home/alice`; the `eq` arm catches the exact-match case.
const DIR_REL = 'trimPrefix "/" (trimPrefix .project_dir .current_dir)';
// [LAW:decomposition] Collapse stays in the template (its inputs are payload fields); abbreviation is a helper applied to the result.
const DIR_TEMPLATE =
  "{{ $dir := .current_dir }}" +
  '{{ if and (ne .home "") (or (eq .home .current_dir) (hasPrefix (printf "%s/" .home) .current_dir)) }}' +
  `{{ $dir = printf "~%s" (trimPrefix .home .current_dir) }}` +
  "{{ else }}" +
  '{{ if or (eq .project_dir .current_dir) (hasPrefix (printf "%s/" .project_dir) .current_dir) }}' +
  `{{ $dir = ternary (${DIR_REL}) (basename .project_dir) (ne (${DIR_REL}) "") }}` +
  "{{ end }}{{ end }}" +
  "{{ abbreviatePath $dir }}";

// [LAW:one-source-of-truth] Git-fact → semantic palette colour, ONE table both git-style segment templates read from.
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

// [LAW:one-source-of-truth] The one place a palette name becomes a template call.
const paint = (fact: keyof typeof GIT_COLOR, content: string): string =>
  `{{ fg (color "${GIT_COLOR[fact]}") ${content} }}`;

// [LAW:dataflow-not-control-flow] Quiet is the default `fg:`, so only the operative facts name a
// colour. The blend target is the segment's OWN background (`bgOf`), and the `readableOn` floor
// is what makes the result theme-independent rather than a fixed percentage. [LAW:verifiable-goals]
const GIT_QUIET_PCT = 60;
const GIT_QUIET_MIN_CONTRAST = 3;
const GIT_QUIET_FG =
  `{{ readableOn (mix (color "foreground") (bgOf) ${GIT_QUIET_PCT}) (bgOf) ` +
  `${GIT_QUIET_MIN_CONTRAST} }}`;

// [LAW:dataflow-not-control-flow] `$first` carries the "have we emitted yet" state, reassigned via `=` up to its declaring frame.
const GIT_WORKTREE =
  "{{ if or (gt .git.staged 0) (gt .git.unstaged 0) (gt .git.untracked 0) (gt .git.conflicts 0) }}" +
  ` ({{ $first := true }}` +
  `{{ if gt .git.staged 0 }}${paint("staged", '(printf "+%v" .git.staged)')}{{ $first = false }}{{ end }}` +
  `{{ if gt .git.unstaged 0 }}{{ if not $first }} {{ end }}${paint("unstaged", '(printf "~%v" .git.unstaged)')}{{ $first = false }}{{ end }}` +
  `{{ if gt .git.untracked 0 }}{{ if not $first }} {{ end }}${paint("untracked", '(printf "?%v" .git.untracked)')}{{ $first = false }}{{ end }}` +
  `{{ if gt .git.conflicts 0 }}{{ if not $first }} {{ end }}${paint("conflicts", '(printf "!%v" .git.conflicts)')}{{ $first = false }}{{ end }}` +
  "){{ end }}";

// Status icon precedence: conflicts → ⚠ (error), dirty → ● (warning), else clean ✓ (success).
const GIT_STATUS =
  '{{ if eq .git.status "conflicts" }}{{ fg (color "error") "⚠" }}{{ else }}' +
  '{{ if eq .git.status "dirty" }}{{ fg (color "warning") "●" }}' +
  '{{ else }}{{ fg (color "success") "✓" }}{{ end }}{{ end }}';

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

// [LAW:dataflow-not-control-flow] Every threshold cascade below is one `ramp … "step" …` call whose
// stops must ASCEND, so a threshold set below its neighbour is a loud render error, never a reorder.

// [LAW:one-source-of-truth] exception: `kind: "group"` is authoring sugar the loader lowers, so a plain
// `satisfies DslConfig` cannot type-check it; it may appear EXACTLY ONCE across the whole config.
const settingsDrawer = {
  kind: "group",
  name: "settings",
  label: "⚙ terminal",
  direction: "horizontal",
  children: ["charsetControl", "colorCompatControl", "directoryPaletteControl"],
} as unknown as LayoutNode;

// [LAW:one-source-of-truth] The AUTHORED literal, pre-synthesis; production code wants DEFAULT_DSL_CONFIG below.
export const RAW_DEFAULT_DSL_CONFIG = {
  globals: {
    palette: "tokyo-night",
  },

  variables: {
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
    // [LAW:one-source-of-truth] The daemon-resolved effective theme name — the SAME name the rendered basePalette is built from.
    "theme.effective": {
      kind: "input",
      path: "theme.effective",
      default: "",
    },
    // [LAW:one-type-per-behavior] The effective LOOK name, theme's twin one dimension over.
    "look.effective": {
      kind: "input",
      path: "look.effective",
      default: "",
    },
    // [LAW:one-type-per-behavior] The effective PRESET name, one level up again.
    "preset.effective": {
      kind: "input",
      path: "preset.effective",
      default: "",
    },
    // [LAW:one-source-of-truth] Whether the config file authors the active preset's root.
    "preset.customized": {
      kind: "input",
      path: "preset.customized",
      type: "boolean",
      default: false,
    },
    // [LAW:one-type-per-behavior] The SAME values BuildLineOptions renders with, read back so a control can show its current selection.
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

    // [LAW:one-source-of-truth] The usable width for THIS render — the same value that feeds the wrap, so a paginated picker cannot disagree with it.
    "term.cols": {
      kind: "input",
      path: "term.cols",
      type: "number",
      default: 80,
    },

    // Sourced via `input` rather than `env` so the `~` collapse works on every platform.
    home: { kind: "input", path: "home", default: "" },

    // An `input` rather than a `shell` declaration, so an unused tmux segment costs no subprocess.
    "tmux.session": { kind: "input", path: "tmux.session", default: "" },

    // `host.ssh` CANNOT be an env var: variables evaluate in the DAEMON, which is detached and serves
    // every session, so its `SSH_*` describes whichever shell spawned it. The client sends the fact as a hint.
    "host.name": { kind: "input", path: "host.name", default: "" },
    "host.user": { kind: "input", path: "host.user", default: "" },
    "host.ssh": {
      kind: "input",
      path: "host.ssh",
      type: "boolean",
      default: false,
    },

    // `input` gives the full 12-field GitInfo surface; the native `kind: "git"` source covers only 6.
    "git.repoName": {
      kind: "input",
      path: "git.repoName",
      default: "",
    },
    // "" is the genuine "no remote a browser can open" — the toolbar reads that value, not a flag.
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

    // [LAW:no-silent-failure] prError is non-empty ONLY when the forge was asked and couldn't answer — distinct from "no PR".
    "git.prNumber": {
      kind: "input",
      path: "git.prNumber",
      type: "number",
      default: 0,
    },
    "git.prState": { kind: "input", path: "git.prState", default: "" },
    "git.prUrl": { kind: "input", path: "git.prUrl", default: "" },
    "git.prError": { kind: "input", path: "git.prError", default: "" },

    // Epoch seconds, the same unit as block/weekly resetsAt; 0 ⇒ no cache activity ⇒ the `when` hides it.
    "cache.expiresAt": {
      kind: "input",
      path: "cache.expiresAt",
      type: "number",
      default: 0,
    },

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
    // [LAW:dataflow-not-control-flow] amount defaults 0, the non-displayable value, so opt-in is a value, not a config mode.
    "session.budget.amount": { kind: "literal", value: 0 },
    "session.budget.warningThreshold": { kind: "literal", value: 80 },

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
    "today.budget.amount": { kind: "literal", value: 50 },
    "today.budget.warningThreshold": { kind: "literal", value: 80 },

    // resetsAt is raw epoch seconds, so the template composes `minutesUntilReset` exactly as weekly does.
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
    "block.budget.warningThreshold": { kind: "literal", value: 80 },
    "block.budget.heatThreshold": { kind: "literal", value: 50 },

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
    "weekly.budget.heatThreshold": { kind: "literal", value: 50 },

    // [LAW:no-silent-failure] -1 is the structurally-impossible absence marker; 0 minutes and $0/hr are real values.
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
    "burn.eta.warnMinutes": { kind: "literal", value: 60 },
    "burn.eta.errorMinutes": { kind: "literal", value: 30 },

    // [LAW:no-silent-failure] -1 is the absence marker (0 tok/s is a real reading); each lane is independently absent.
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
    // A series cannot cross the scalar var-system seam, so it travels as a comma-delimited string the `sparkline` helper decodes.
    "speed.history": {
      kind: "input",
      path: "speed.history",
      type: "string",
      default: "",
    },

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

    // No page-cursor var: a {{ menu }} synthesizes its own under the reserved menus.* namespace.
  },

  // [LAW:dataflow-not-control-flow] A segment authors a `bg:` only when the colour STATES something —
  // a threshold or an alert; every other cell wears the vocabulary tint its address selects.
  // [LAW:one-source-of-truth] Templates author CONTENT only; intra-cell padding is structural, never authored here.
  segments: {
    directory: {
      template: DIR_TEMPLATE,
      fg: "foreground",
    },
    model: {
      template: "✱ {{ formatModelName .model.display_name }}",
      fg: "foreground",
      when: '{{ ne .model.display_name "" }}',
    },
    sessionId: {
      template: "⌗{{ trunc 8 .session.id }}",
      fg: "foreground",
      when: '{{ ne .session.id "" }}',
    },
    version: {
      template: "◈ v{{ .version }}",
      fg: "foreground",
      when: '{{ ne .version "" }}',
    },
    tmux: {
      template: 'tmux:{{ .tmux.session | default "none" }}',
      fg: "foreground",
      when: '{{ ne .tmux.session "" }}',
    },
    // [LAW:dataflow-not-control-flow] Presence IS the signal: no SSH "mode" and no force-on flag [LAW:no-mode-explosion].
    // [LAW:no-silent-failure] Each half falls back to "?", so a failed read still reads as remote rather than as a blank.
    // `bg: "warning"` is load-bearing — a hue-ANCHORED root, so it still reads as an alert under every theme and look.
    host: {
      template:
        '⇄ {{ .host.user | default "?" }}@{{ .host.name | default "?" }}',
      bg: "warning",
      fg: "{{ contrastOn (bgOf) }}",
      when: "{{ .host.ssh }}",
    },
    git: {
      template: GIT_TEMPLATE,
      // A computed `fg:`; `bgOf` is available because a segment's background resolves before its foreground.
      fg: GIT_QUIET_FG,
      when: '{{ ne .git.branch "" }}',
    },
    gitaculous: {
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
      fg: GIT_QUIET_FG,
      when: '{{ ne .git.branch "" }}',
    },
    // OPT-IN: declared but NOT in the default root, since it adds a network gh/glab call.
    // [LAW:no-silent-failure] A lookup FAILURE renders a distinct ⚠ so an outage is not mistaken for "no PR".
    gitPr: {
      // The pad spaces are structural chrome OUTSIDE the OSC-8 region — the clickable area is the glyph text.
      template:
        '{{ if ne .git.prUrl "" }}' +
        '{{ link .git.prUrl (printf "⇆ #%v" .git.prNumber) }}' +
        "{{ else }}⚠ PR{{ end }}",
      fg: "foreground",
      when: '{{ or (ne .git.prUrl "") (ne .git.prError "") }}',
    },
    // [LAW:locality-or-seam] The glyph is the REPRESENTATION, the named action the BEHAVIOR, the name the seam.
    // `↗ repo` is not an action: the daemon already resolved an https page, so `{{ link }}` hands it to the terminal.
    // [LAW:carrying-cost] The edit trigger folds into `toolbar`, so removing it costs the whole tray rather than one click.
    toolbar: {
      template:
        '{{ action "copySession" "⎘ id" }}' +
        ' {{ action "openProject" "↗ proj" }} {{ action "openTranscript" "↗ log" }}' +
        '{{ if ne .git.repoUrl "" }} {{ link .git.repoUrl "↗ repo" }}{{ end }}' +
        ' {{ action "edit.toggle" "✎ edit" "✎ done" }}',
      fg: "foreground",
    },
    session: {
      template:
        '§ {{ template "formatCost" .session.cost }} ({{ template "formatTokens" .session.tokens }})' +
        '{{ template "budgetStatus" (dict "cost" .session.cost "budget" .session.budget.amount "warn" .session.budget.warningThreshold) }}',
      fg: "foreground",
    },
    today: {
      template:
        '☉ {{ template "formatCost" .today.cost }} ({{ template "formatTokens" .today.tokens }})' +
        '{{ template "budgetStatus" (dict "cost" .today.cost "budget" .today.budget.amount "warn" .today.budget.warningThreshold) }}',
      fg: "foreground",
    },
    block: {
      template:
        "◱ {{ round .block.nativeUtilization }}% " +
        '({{ template "formatResetCountdown" .block.resetsAt }})',
      bg: '{{ ramp (round .block.nativeUtilization) "step" 0 "panel" .block.budget.heatThreshold "warning" .block.budget.warningThreshold "error" }}',
      fg: '{{ ramp (round .block.nativeUtilization) "step" 0 "foreground" .block.budget.heatThreshold "button-color-foreground" }}',
      when: "{{ gt .block.resetsAt 0 }}",
    },
    weekly: {
      template:
        "◑ {{ round .weekly.percentage }}% " +
        '({{ template "formatResetCountdown" .weekly.resetsAt }})',
      bg: '{{ ramp (round .weekly.percentage) "step" 0 "panel" .weekly.budget.heatThreshold "warning" .weekly.budget.warningThreshold "error" }}',
      fg: '{{ ramp (round .weekly.percentage) "step" 0 "foreground" .weekly.budget.heatThreshold "button-color-foreground" }}',
      when: "{{ gt .weekly.resetsAt 0 }}",
    },
    // Heats as the 5h cap NEARS — the ramp runs over minutes-to-cap, the inverse of block's fuller-is-hotter.
    burnrate: {
      template:
        '⚡ {{ template "formatRate" .burn.costPerHour }} · ' +
        '{{ template "formatEta" .block.etaMinutes }} to 5h · ' +
        '{{ template "formatEta" .weekly.etaMinutes }} to wk',
      bg: '{{ ramp .block.etaMinutes "step" -1 "panel" 0 "error" .burn.eta.errorMinutes "warning" .burn.eta.warnMinutes "panel" }}',
      fg: '{{ ramp .block.etaMinutes "step" -1 "foreground" 0 "button-color-foreground" .burn.eta.warnMinutes "foreground" }}',
      when: "{{ or (gt .block.resetsAt 0) (gt .weekly.resetsAt 0) }}",
    },
    // Declared-but-opt-in. [LAW:no-silent-failure] Each lane reads "—" when idle, never a stale number.
    speed: {
      template:
        '⇅ out {{ template "formatSpeed" .speed.output }} · ' +
        'in {{ template "formatSpeed" .speed.input }} · ' +
        'tot {{ template "formatSpeed" .speed.total }}',
      fg: "foreground",
      when: "{{ gt .session.tokens 0 }}",
    },
    // Declared-but-opt-in. Gated on the history being present, since the series needs two samples before its first bar. [LAW:effects-at-boundaries]
    tokenSparkline: {
      template: "⚡ {{ sparkline .speed.history 24 }}",
      fg: "foreground",
      when: '{{ ne .speed.history "" }}',
    },
    // minutesUntilReset clamps a past expiry to 0, so an expired cache reads "cold" rather than a negative number.
    cacheTimer: {
      template:
        "◴ {{ if le (minutesUntilReset .cache.expiresAt) 0 }}cold" +
        "{{ else }}{{ minutesUntilReset .cache.expiresAt }}m{{ end }}",
      fg:
        "{{ if le (minutesUntilReset .cache.expiresAt) 8 }}error" +
        "{{ else }}{{ if le (minutesUntilReset .cache.expiresAt) 20 }}warning" +
        "{{ else }}foreground{{ end }}{{ end }}",
      when: "{{ gt .cache.expiresAt 0 }}",
    },
    context: {
      template:
        "◔ {{ formatInteger .context.totalTokens }} ({{ .context.contextLeft }}%)",
      // contextLeft is an integer, so the "≤ 20 / ≤ 40" edges are the stops at 21 and 41 exactly.
      bg: '{{ ramp .context.contextLeft "step" 0 "error" 21 "warning" 41 "surface-active" }}',
      fg: '{{ ramp .context.contextLeft "step" 0 "button-color-foreground" 41 "foreground" }}',
      when: "{{ gt .context.totalTokens 0 }}",
    },
    metrics: {
      // [LAW:dataflow-not-control-flow] Each part guards on its own value; the segment-level `when` is a weak any-present check so a metric-less payload renders no cell.
      // [LAW:one-source-of-truth] exception: each arm's leading space is the SEPARATOR between present parts — only data can decide which part is first.
      template:
        '{{ if .metrics.lastResponseTime }} Δ {{ template "formatResponseTime" .metrics.lastResponseTime }}{{ end }}' +
        '{{ if .metrics.responseTime }} ⧖ {{ template "formatResponseTime" .metrics.responseTime }}{{ end }}' +
        '{{ if .metrics.sessionDuration }} ⧗ {{ template "formatDuration" .metrics.sessionDuration }}{{ end }}' +
        "{{ if .metrics.messageCount }} ◆ {{ .metrics.messageCount }}{{ end }}" +
        "{{ if .metrics.linesAdded }} + {{ .metrics.linesAdded }}{{ end }}" +
        "{{ if .metrics.linesRemoved }} - {{ .metrics.linesRemoved }}{{ end }} ",
      fg: "foreground",
      when:
        "{{ or .metrics.lastResponseTime .metrics.responseTime" +
        " .metrics.sessionDuration .metrics.messageCount" +
        " .metrics.linesAdded .metrics.linesRemoved }}",
    },
    // `charset`/`colorCompatibility` describe the terminal, not a per-session taste, so `persist` is their only seam.
    charsetControl: {
      template:
        "{{ .charset.effective }} " +
        `{{ menu "applyCharsetForever" "${DISCLOSURE_GLYPH_CLOSED}" "${DISCLOSURE_GLYPH_OPEN}" }} ` +
        '{{ action "resetCharset" "↺" }}',
      fg: "foreground",
    },
    colorCompatControl: {
      template:
        "{{ .colorCompatibility.effective }} " +
        `{{ menu "applyColorCompatForever" "${DISCLOSURE_GLYPH_CLOSED}" "${DISCLOSURE_GLYPH_OPEN}" }} ` +
        '{{ action "resetColorCompat" "↺" }}',
      fg: "foreground",
    },
    // [LAW:one-source-of-truth] exception: there is no `segments.directory.palette.effective` projection, so this control loses only the picker's current-selection highlight.
    directoryPaletteControl: {
      template:
        "🎨 directory " +
        `{{ menu "applyDirectoryPaletteForever" "${DISCLOSURE_GLYPH_CLOSED}" "${DISCLOSURE_GLYPH_OPEN}" }} ` +
        '{{ action "resetDirectoryPalette" "↺" }}',
      fg: "foreground",
    },
  },

  // [LAW:one-source-of-truth] The row NAMES are the merge keys: a user's `root: { rows: { status } }`
  // replaces exactly that row and inherits the other, and `status: { h: [] }` removes one.
  // [LAW:dataflow-not-control-flow] Every status segment is when-gated on its own signal, so a row only ever shows segments with real data.
  root: {
    rows: {
      identity: {
        kind: "container",
        direction: "horizontal",
        children: [
          // Leads the identity row: WHICH MACHINE reframes every path and branch to its right.
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

  // [LAW:locality-or-seam] The tray's behaviors, decoupled by NAME from the glyphs above. [LAW:single-enforcer] The click-wire codec owns ALL percent-encoding.
  // open* pass a bare filesystem path, NOT a `vscode://` URL, which `open -a` would treat as a literal filename.
  actions: {
    copySession: { copy: "{{ .session.id }}" },
    copyDir: { copy: "{{ .current_dir }}" },
    openProject: { open: "{{ .project_dir }}" },
    openTranscript: { open: "{{ .transcript_path }}" },

    // [LAW:locality-or-seam] Durable-only by NATURE: these describe the terminal, so there is no session half to choose between.
    applyCharsetForever: { persist: "charset", from: "charsets" },
    resetCharset: { reset: "charset" },
    applyColorCompatForever: {
      persist: "colorCompatibility",
      from: "colorCompatibilities",
    },
    resetColorCompat: { reset: "colorCompatibility" },

    // [LAW:locality-or-seam] The target key is `segments.directory.palette` — not a Globals field — riding the same generic persist/reset machinery.
    applyDirectoryPaletteForever: {
      persist: "segments.directory.palette",
      from: "themes",
    },
    resetDirectoryPalette: { reset: "segments.directory.palette" },
  },

  // [LAW:one-source-of-truth] A look is a transform, not a palette, and merges by name, so the "none" identity floor is in every merged config.
  looks: {
    // [LAW:dataflow-not-control-flow] "none" is the identity look — the resolution floor as a value. Spelled literally so the default stays inert JSON-shaped data.
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
    // Lightness down (scale) / up (shift); anchors stay hue-locked by rich-js.
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
    // The dark↔light "octave" flip (L' = 1 - L) — errors stay red, dark-on-light becomes light-on-dark.
    inverted: {
      hueShift: 0,
      chromaScale: 1,
      lightnessScale: -1,
      lightnessShift: 1,
    },
  },

  // [LAW:one-source-of-truth] Named config FRAGMENTS, merged by name, so this stdlib is in every merged config.
  // [LAW:carrying-cost] A bundled preset can only STAGE segments already declared, never introduce one.
  presets: {
    // [LAW:dataflow-not-control-flow] "default" is the identity fragment: no `root`, no `globals`, so it stages the config's own.
    default: {},

    // [LAW:no-silent-failure] No preset control of its own: the settings menu is spliced into EVERY preset root, so one click gets back.
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

    // Surfaces every segment declared but NOT in the default root, for a full usage-monitor picture.
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

  // [LAW:one-source-of-truth] What edit mode LOOKS like, as config a user can retune. `plain` trades powerline caps for a visible separator between cells.
  // The separator is stated rather than defaulted, and is " | " (not "│") because it must survive `charset: "ascii"`.
  editGlobals: {
    style: "plain",
    default_separator: " | ",
  },

  // [LAW:single-enforcer] / [LAW:one-source-of-truth] Display policy lives here as named helpers, each DEFINED ONCE, so the K/M scale rule cannot drift between callers.
  // [LAW:dataflow-not-control-flow] A multi-input helper receives its inputs as one `dict` through its single dot arg.
  helpers: {
    // Under a cent reads "<$0.01"; null is unrepresentable through the var-system, so no null branch.
    formatCost:
      '{{ if lt . 0.01 }}<$0.01{{ else }}${{ printf "%.2f" . }}{{ end }}',
    // The single home of the K/M token-scale rule. No " tokens" suffix — that is formatTokens' job.
    formatTokenCount:
      '{{ if ge . 1000000 }}{{ printf "%.1f" (divf . 1000000) }}M' +
      '{{ else if ge . 1000 }}{{ printf "%.1f" (divf . 1000) }}K' +
      "{{ else }}{{ . }}{{ end }}",
    formatTokens: '{{ template "formatTokenCount" . }} tokens',
    // -1 is a structurally-impossible rate, so the branch reads a VALUE, never a hidden flag.
    formatRate:
      '{{ if lt . 0 }}—/hr{{ else }}{{ template "formatCost" . }}/hr{{ end }}',
    formatEta:
      '{{ if lt . 0 }}—{{ else }}{{ template "formatLongTimeRemaining" . }}{{ end }}',
    formatSpeed:
      '{{ if lt . 0 }}—{{ else }}{{ template "formatTokenCount" (round .) }}/s{{ end }}',
    // A `$first` flag inserts the separator before all but the first present part; all-zero collapses to "0 tokens".
    formatTokenBreakdown:
      "{{ $first := true }}" +
      '{{ if gt .input 0 }}{{ template "formatTokenCount" .input }} in{{ $first = false }}{{ end }}' +
      '{{ if gt .output 0 }}{{ if not $first }} + {{ end }}{{ template "formatTokenCount" .output }} out{{ $first = false }}{{ end }}' +
      '{{ if or (gt .cacheCreation 0) (gt .cacheRead 0) }}{{ if not $first }} + {{ end }}{{ template "formatTokenCount" (add .cacheCreation .cacheRead) }} cached{{ $first = false }}{{ end }}' +
      "{{ if $first }}0 tokens{{ end }}",
    // Non-displayable (budget <= 0 or cost < 0) → "".
    budgetStatus:
      "{{ if or (le .budget 0) (lt .cost 0) }}{{ else }}" +
      "{{ $pct := minf 100 (mulf (divf .cost .budget) 100) }}" +
      '{{ $p := printf "%.0f%%" $pct }}' +
      "{{ if ge $pct .warn }} !{{ $p }}" +
      "{{ else }}{{ if ge $pct 50 }} +{{ $p }}{{ else }} {{ $p }}{{ end }}{{ end }}" +
      "{{ end }}",

    // [LAW:dataflow-not-control-flow] The cascades branch on the VALUE — which unit threshold it falls in. `printf "%.Nf"` is the toFixed stand-in.

    formatTimeSince:
      "{{ if lt . 60 }}{{ . }}s" +
      "{{ else if lt . 3600 }}{{ div . 60 }}m" +
      "{{ else if lt . 86400 }}{{ div . 3600 }}h" +
      "{{ else if lt . 604800 }}{{ div . 86400 }}d" +
      "{{ else }}{{ div . 604800 }}w{{ end }}",
    formatDuration:
      '{{ if lt . 60 }}{{ printf "%.0f" . }}s' +
      '{{ else if lt . 3600 }}{{ printf "%.0f" (divf . 60) }}m' +
      '{{ else if lt . 86400 }}{{ printf "%.1f" (divf . 3600) }}h' +
      '{{ else }}{{ printf "%.1f" (divf . 86400) }}d{{ end }}',
    formatResponseTime:
      '{{ if lt . 60 }}{{ printf "%.1f" . }}s' +
      '{{ else }}{{ printf "%.1f" (divf . 60) }}m{{ end }}',
    // `$d`/`$h`/`$m` are declared in the branch frame and read by the inner if — go-template-js cannot capture a value any other way.
    formatLongTimeRemaining:
      "{{ if ge . 1440 }}{{ $d := div . 1440 }}{{ $h := div (mod . 1440) 60 }}" +
      "{{ if gt $h 0 }}{{ $d }}d {{ $h }}h{{ else }}{{ $d }}d{{ end }}" +
      "{{ else if ge . 60 }}{{ $h := div . 60 }}{{ $m := mod . 60 }}" +
      "{{ if gt $m 0 }}{{ $h }}h {{ $m }}m{{ else }}{{ $h }}h{{ end }}" +
      "{{ else }}{{ . }}m{{ end }}",
    // The minute in progress counts, so a reset seconds away reads "1m" — a uniform +1, deliberately not a floor at 1.
    formatResetCountdown:
      '{{ template "formatLongTimeRemaining" (add 1 (minutesUntilReset .)) }}',
  },
} satisfies DslConfig;

// [LAW:locality-or-seam] This module-level parse validates against names DERIVED from the literal
// itself, never the live theme registry, so a registry bug cannot crash every importer at import time.
const AUTHORED_PALETTE_NAMES = new Set(
  [
    RAW_DEFAULT_DSL_CONFIG.globals.palette,
    ...(Object.values(RAW_DEFAULT_DSL_CONFIG.segments) as SegmentDecl[]).map(
      (s) => s.palette,
    ),
  ].filter((name): name is string => name !== undefined),
);

// [LAW:single-enforcer] Run the authored literal through the SAME parse → synthesize pipeline every
// user config takes; without it the zero-config path would ship an UNSYNTHESIZED default whose menus reject clicks.
export const DEFAULT_DSL_CONFIG: DslConfig = mergeWithDefault(
  parseDslConfig(
    "<default>",
    JSON.stringify(RAW_DEFAULT_DSL_CONFIG),
    AUTHORED_PALETTE_NAMES,
  ),
  RAW_DEFAULT_DSL_CONFIG,
);
