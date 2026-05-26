// [LAW:one-source-of-truth] The bundled default DslConfig — the statusline
// rendered when no `.cc-candybar.json5` is present at any resolution layer.
// This is the canonical port of every built-in segment as a DSL declaration,
// covering the surface previously expressed by the legacy renderer that was
// retired in bzh.2.
//
// [LAW:single-enforcer] One default. The daemon's render cache either loads
// the user's DSL file or falls back to this constant — no merging, no
// per-segment cascade. Customization is a complete config-file replacement;
// JSON5 supports inline comments, so users can copy this file (or the
// runnable demo at `src/demo/statusline.json5`) into `.cc-candybar.json5`
// and edit.
//
// [LAW:dataflow-not-control-flow] Every segment is declared regardless of
// whether the default `layout` includes it — `layout` is the value that
// chooses what renders. Switching a disabled segment on is a `layout`-array
// edit, not new code. The same data flows through the same render path
// whether layout has 1 entry or 16.
//
// [LAW:types-are-the-program] `satisfies DslConfig` (not an annotation)
// preserves the literal's narrow keys for downstream consumers — every
// declared segment name shows up as a known key, every variable name shows
// up in the input set the daemon must populate.

import type { DslConfig } from "./dsl-types.js";

// ─── Shared template fragments ───────────────────────────────────────────────
//
// Factored out of the segments' `template` fields so:
//   (1) the git working-tree counts and status icon can be shared by the two
//       git-style segments (git, gitTaculous) without duplication, and
//   (2) the block/weekly threshold cascade can be parameterized on the
//       variable name without resorting to runtime string surgery.

// Directory: ~ collapse under $HOME, project-relative under workspace.project_dir,
// else raw. Inline-recomputes the project-relative path because the DSL has no
// template-level `:=` (a `kind: "template"` var would express it once, but adds
// noise for a single use).
const DIR_REL = 'trimPrefix "/" (trimPrefix .project_dir .current_dir)';
const DIR_TEMPLATE =
  ' {{ if and (ne .home "") (hasPrefix .home .current_dir) }}~{{ trimPrefix .home .current_dir }}' +
  "{{ else }}" +
  "{{ if and (ne .project_dir .current_dir) (hasPrefix .project_dir .current_dir) }}" +
  `{{ ternary (${DIR_REL}) (basename .project_dir) (ne (${DIR_REL}) "") }}` +
  "{{ else }}{{ .current_dir }}{{ end }}{{ end }} ";

// Git working-tree counts — leading-space-then-trim idiom: each present count
// contributes " +N", trim drops the leading space, survivors single-spaced.
const GIT_WORKTREE =
  "{{ if or (gt .git.staged 0) (gt .git.unstaged 0) (gt .git.untracked 0) (gt .git.conflicts 0) }}" +
  ' ({{ printf "%s%s%s%s"' +
  ' (ternary (printf " +%v" .git.staged) "" (gt .git.staged 0))' +
  ' (ternary (printf " ~%v" .git.unstaged) "" (gt .git.unstaged 0))' +
  ' (ternary (printf " ?%v" .git.untracked) "" (gt .git.untracked 0))' +
  ' (ternary (printf " !%v" .git.conflicts) "" (gt .git.conflicts 0)) | trim }}){{ end }}';

// Status icon precedence: conflicts → ⚠, dirty → ●, else clean ✓.
const GIT_STATUS =
  '{{ if eq .git.status "conflicts" }}⚠{{ else }}' +
  '{{ if eq .git.status "dirty" }}●{{ else }}✓{{ end }}{{ end }}';

const GIT_TEMPLATE =
  ' {{ if ne .git.repoName "" }}{{ .git.repoName }} {{ end }}⎇ {{ .git.branch }}' +
  "{{ if .git.sha }} ♯ {{ .git.sha }}{{ end }}" +
  "{{ if or (gt .git.ahead 0) (gt .git.behind 0) }}" +
  " {{ if gt .git.ahead 0 }}↑{{ .git.ahead }}{{ end }}" +
  "{{ if gt .git.behind 0 }}↓{{ .git.behind }}{{ end }}{{ end }}" +
  GIT_WORKTREE +
  "{{ if .git.upstream }} →{{ .git.upstream }}{{ end }}" +
  "{{ if gt .git.stash 0 }} ⧇ {{ .git.stash }}{{ end }}" +
  " " +
  GIT_STATUS +
  " ";

// [LAW:dataflow-not-control-flow] block and weekly share the same threshold
// cascade (≥80 → error, ≥50 → warning, else panel) on a numeric ref. The
// builders parameterize the variable name; same shape, different ref.
function blockLikeBg(pctRef: string): string {
  return (
    `{{ if ge (round ${pctRef}) 80 }}error` +
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

// ─── The default config ──────────────────────────────────────────────────────

export const DEFAULT_DSL_CONFIG = {
  globals: {
    // Picked by the daemon's basePalette resolution; user overrides in their
    // own config. textual-dark matches the demo's default and ships with
    // every required spec name (surface, panel, accent, secondary, primary,
    // foreground, button-color-foreground, warning, error, surface-active).
    palette: "textual-dark",
    // Adjacent segments rotate hue by 14° so they stay visually distinct
    // without authoring per-segment colors.
    hueStep: 14,
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
    "model.display_name": {
      kind: "input",
      path: "model.display_name",
      default: "",
    },
    "session.id": { kind: "input", path: "session_id", default: "" },
    version: { kind: "input", path: "version", default: "" },

    // home flows through the augmented payload (buildRenderPayload reads
    // HOME, falling back to USERPROFILE on Windows where HOME is often
    // unset). Sourcing via `kind: "input"` rather than `kind: "env",
    // name: "HOME"` makes the directory `~` collapse work on every
    // platform without per-platform config edits.
    home: { kind: "input", path: "home", default: "" },

    // Per-session daemon state — surfaced for click-aware segments.
    theme: { kind: "input", path: "theme", default: "" },

    // Tmux session id flows through the daemon's augmented payload
    // (TmuxService caches by socket and never re-spawns for the lifetime of
    // the daemon, so this stays cheap). A `kind: "shell"` declaration would
    // spawn the subprocess at every cache-entry creation regardless of
    // whether the tmux segment is in the active layout — buildNeededPrefixes
    // gates the input variant so unused segments cost nothing.
    "tmux.session": { kind: "input", path: "tmux.session", default: "" },

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

    // Usage / cost — daemon fetches via UsageProvider; numeric.
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

    // Today — daemon fetches via TodayProvider.
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

    // Block — daemon fetches via BlockProvider; resetsAt is raw epoch seconds
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
  },

  // ─── Segments ──────────────────────────────────────────────────────────────
  // Every built-in. Templates ported from the parity bindings; bg/fg are the
  // palette spec names that buildPaletteMapping(style="surface") historically
  // assigned each segment's semantic variant. `when` predicates hide a
  // segment when its primary signal is absent (no git repo, no version field,
  // no env var, no tmux, no rate-limit window).
  segments: {
    directory: {
      template: DIR_TEMPLATE,
      bg: "surface",
      fg: "foreground",
    },
    model: {
      template: " ✱ {{ formatModelName .model.display_name }} ",
      bg: "panel",
      fg: "foreground",
      when: '{{ ne .model.display_name "" }}',
    },
    sessionId: {
      template: " ⌗{{ trunc 8 .session.id }} ",
      bg: "surface",
      fg: "foreground",
      when: '{{ ne .session.id "" }}',
    },
    version: {
      template: " ◈ v{{ .version }} ",
      bg: "surface",
      fg: "foreground",
      when: '{{ ne .version "" }}',
    },
    tmux: {
      template: ' tmux:{{ .tmux.session | default "none" }} ',
      bg: "surface-active",
      fg: "foreground",
      when: '{{ ne .tmux.session "" }}',
    },
    git: {
      template: GIT_TEMPLATE,
      bg: "surface-active",
      fg: "foreground",
      when: '{{ ne .git.branch "" }}',
    },
    gitTaculous: {
      template:
        " (git)" +
        '{{ if ne .git.repoName "" }} {{ .git.repoName }}{{ end }}' +
        '{{ if ne .git.sha "" }} {{ .git.sha }}{{ end }}' +
        "{{ if or (gt .git.staged 0) (gt .git.unstaged 0) (gt .git.untracked 0) (gt .git.conflicts 0) }} " +
        '{{ if gt .git.staged 0 }}{{ green "S" }}{{ end }}' +
        '{{ if or (gt .git.unstaged 0) (gt .git.untracked 0) }}{{ red "U" }}{{ end }}' +
        '{{ if gt .git.conflicts 0 }}{{ red (printf "!%v" .git.conflicts) }}{{ end }}' +
        "{{ end }}" +
        " ⎇ {{ .git.branch }}" +
        '{{ if ne .git.upstream "" }} [{{ .git.upstream }}' +
        "{{ if or (gt .git.ahead 0) (gt .git.behind 0) }} " +
        '{{ if gt .git.ahead 0 }}{{ green (printf "+%v" .git.ahead) }}{{ end }}' +
        "{{ if and (gt .git.ahead 0) (gt .git.behind 0) }}/{{ end }}" +
        '{{ if gt .git.behind 0 }}{{ red (printf "-%v" .git.behind) }}{{ end }}' +
        "{{ end }}]{{ end }} ",
      bg: "surface-active",
      fg: "foreground",
      when: '{{ ne .git.branch "" }}',
    },
    toolbar: {
      template:
        ' {{ link (printf "cc-candybar://open-vscode/%s" (urlEncode .current_dir)) "\u{1F4C2}" }}' +
        ' {{ link (printf "cc-candybar://copy/%s" (urlEncode (trunc 8 .session.id))) "⎘" }} ',
      bg: "surface",
      fg: "foreground",
    },
    tray: {
      template:
        ' {{ link (printf "cc-candybar://open-url/%s" (urlEncode .theme)) "\u{1F514}" }}' +
        ' {{ link (printf "cc-candybar://copy/%s" (urlEncode (trunc 8 .session.id))) "⚙" }} ',
      bg: "surface",
      fg: "foreground",
    },
    session: {
      template:
        " § {{ formatCost .session.cost }} ({{ formatTokens .session.tokens }}) ",
      bg: "surface",
      fg: "foreground",
    },
    today: {
      template:
        " ☉ {{ formatCost .today.cost }} ({{ formatTokens .today.tokens }})" +
        "{{ budgetStatus .today.cost .today.budget.amount .today.budget.warningThreshold }} ",
      bg: "surface",
      fg: "foreground",
    },
    block: {
      template:
        " ◱ {{ round .block.nativeUtilization }}% " +
        "({{ formatLongTimeRemaining (minutesUntilReset .block.resetsAt) }}) ",
      bg: blockLikeBg(".block.nativeUtilization"),
      fg: blockLikeFg(".block.nativeUtilization"),
      // Hide unless we have a five-hour-window snapshot.
      when: "{{ gt .block.resetsAt 0 }}",
    },
    weekly: {
      template:
        " ◑ {{ round .weekly.percentage }}% " +
        "({{ formatLongTimeRemaining (minutesUntilReset .weekly.resetsAt) }}) ",
      bg: blockLikeBg(".weekly.percentage"),
      fg: blockLikeFg(".weekly.percentage"),
      when: "{{ gt .weekly.resetsAt 0 }}",
    },
    context: {
      template:
        " ◔ {{ formatInteger .context.totalTokens }} ({{ .context.contextLeft }}%) ",
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
      template:
        " Δ {{ formatResponseTime .metrics.lastResponseTime }}" +
        " ⧖ {{ formatResponseTime .metrics.responseTime }}" +
        " ⧗ {{ formatDuration .metrics.sessionDuration }}" +
        " ◆ {{ .metrics.messageCount }}" +
        " + {{ .metrics.linesAdded }}" +
        " - {{ .metrics.linesRemoved }} ",
      bg: "panel",
      fg: "foreground",
      when: "{{ gt .metrics.sessionDuration 0 }}",
    },
  },

  // Default layout — matches the historical default-enabled segment list.
  // Users opt segments in by editing this array; nothing else changes when
  // they do, because every segment is already declared above.
  layout: ["directory", "git", "model", "session", "today", "context"],
} satisfies DslConfig;
