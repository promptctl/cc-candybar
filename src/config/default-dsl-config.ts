// [LAW:one-source-of-truth] The bundled default DslConfig — the statusline
// rendered when no `.cc-candybar.json5` (or `.cc-candybar.json`) is present
// at any resolution layer. This is the canonical port of every built-in
// segment as a DSL declaration, covering the surface previously expressed
// by the legacy renderer that was retired in bzh.2.
//
// [LAW:single-enforcer] One default. User configs merge on top via
// `mergeWithDefault`: globals shallow-merge per field, variables/segments/
// helpers/widgets merge by name (user wins per name), layout replaces
// wholesale when present. A user file only needs to declare what differs —
// overriding one segment or variable takes a few lines. JSON5 supports
// inline comments so users can declare only the delta. The `.json` extension
// is also accepted (JSON ⊂ JSON5, same parser); `.json5` is preferred when
// both exist at the same location.
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
const DIR_TEMPLATE =
  ' {{ if and (ne .home "") (or (eq .home .current_dir) (hasPrefix (printf "%s/" .home) .current_dir)) }}~{{ trimPrefix .home .current_dir }}' +
  "{{ else }}" +
  '{{ if or (eq .project_dir .current_dir) (hasPrefix (printf "%s/" .project_dir) .current_dir) }}' +
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

// ─── The default config ──────────────────────────────────────────────────────

export const DEFAULT_DSL_CONFIG = {
  globals: {
    // Picked by the daemon's basePalette resolution; user overrides in their
    // own config. catppuccin-latte ships every spec name the default
    // segments reference (surface, panel, surface-active, foreground).
    palette: "catppuccin-latte",
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

    // [LAW:one-source-of-truth] The per-segment hue-rotation step renderDsl
    // reads (HUE_STEP_VAR) — a value in the store like every other render input,
    // NOT a globals field. [LAW:types-are-the-program] In the bundled default it
    // is a LITERAL: nothing here writes the "hue-step" SessionState key (the
    // default declares no interactive actions), so a fixed 14° is the strongest
    // TRUE theorem — a `state` var would claim a session-variability the default
    // never exercises and force a SessionState on every consumer. A user makes
    // hue live by overriding this one variable to `{ kind: "state", key:
    // "hue-step" }` and adding a pair of bounded stepper actions — the same
    // two-part pattern the theme picker uses.
    // 14°: adjacent segments stay visually distinct without per-segment colors.
    "hue.step": { kind: "literal", value: 14 },

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
  // Every built-in. Templates ported from the parity bindings; bg/fg are
  // palette spec names resolved against the active theme. `when` predicates
  // hide a segment when its primary signal is absent (no git repo, no version
  // field, no env var, no tmux, no rate-limit window).
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
        '{{ if ne .git.operation "" }} [{{ .git.operation }}]{{ end }}' +
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
        "{{ end }}]{{ end }}" +
        "{{ if gt .git.stash 0 }} ({{ .git.stash }} stashed){{ end }}" +
        '{{ if gt .git.timeSinceCommit 0 }} ◷ {{ template "formatTimeSince" .git.timeSinceCommit }}{{ end }}' +
        " ",
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
    session: {
      template:
        ' § {{ template "formatCost" .session.cost }} ({{ template "formatTokens" .session.tokens }}) ',
      bg: "surface",
      fg: "foreground",
    },
    today: {
      template:
        ' ☉ {{ template "formatCost" .today.cost }} ({{ template "formatTokens" .today.tokens }})' +
        '{{ template "budgetStatus" (dict "cost" .today.cost "budget" .today.budget.amount "warn" .today.budget.warningThreshold) }} ',
      bg: "surface",
      fg: "foreground",
    },
    block: {
      template:
        " ◱ {{ round .block.nativeUtilization }}% " +
        '({{ template "formatLongTimeRemaining" (minutesUntilReset .block.resetsAt) }}) ',
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
        " ◑ {{ round .weekly.percentage }}% " +
        '({{ template "formatLongTimeRemaining" (minutesUntilReset .weekly.resetsAt) }}) ',
      bg: blockLikeBg(".weekly.percentage", ".weekly.budget.warningThreshold"),
      fg: blockLikeFg(".weekly.percentage"),
      when: "{{ gt .weekly.resetsAt 0 }}",
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
        " ◴ {{ if le (minutesUntilReset .cache.expiresAt) 0 }}cold" +
        "{{ else }}{{ minutesUntilReset .cache.expiresAt }}m{{ end }} ",
      bg: "surface",
      fg:
        "{{ if le (minutesUntilReset .cache.expiresAt) 8 }}error" +
        "{{ else }}{{ if le (minutesUntilReset .cache.expiresAt) 20 }}warning" +
        "{{ else }}foreground{{ end }}{{ end }}",
      when: "{{ gt .cache.expiresAt 0 }}",
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
      // [LAW:dataflow-not-control-flow] Each part guards on its own value
      // rather than gating the whole segment on a single dimension. With
      // MetricsPayload's fields independently optional and pickNonNull
      // dropping nulls (see src/daemon/render-payload.ts), an absent field
      // resolves through the var-system fallback chain to 0 — the same
      // falsy shape the per-part `if` test treats as hidden. The segment-
      // level `when` survives as a weak any-present check so a payload
      // with zero metrics data renders no cell at all (an empty template
      // would otherwise produce a single-space bg-styled cell).
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
  },

  // Default layout — the canonical node tree: a vertical container holding one
  // horizontal container of `segment` refs (the historical default-enabled
  // segment list). The default authors `root` directly in the canonical
  // `container | segment` grammar (rather than the `layout`/`cells` sugar) so the
  // bundled config exercises the same surface every other config lowers to
  // [LAW:one-source-of-truth]. Adding rows = appending more horizontal-container
  // children; nesting = a deeper `container`. Every segment is already declared
  // above, and the renderer walks the tree uniformly.
  root: {
    kind: "container",
    direction: "vertical",
    children: [
      {
        kind: "container",
        direction: "horizontal",
        children: [
          { kind: "segment", name: "directory" },
          { kind: "segment", name: "git" },
          { kind: "segment", name: "model" },
          { kind: "segment", name: "session" },
          { kind: "segment", name: "today" },
          { kind: "segment", name: "context" },
        ],
      },
    ],
  },

  // [LAW:locality-or-seam] No decoupled actions in the bundled default either —
  // the baseline statusline binds no clickable regions. A user config declares
  // named actions and binds them from a segment template via
  // `{{ action "name" … }}`; the merge cascade adds them by name.
  actions: {},

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
