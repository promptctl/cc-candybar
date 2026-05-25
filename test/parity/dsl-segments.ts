// [LAW:one-source-of-truth] The DSL counterpart of each migrated built-in
// segment. registry.ts flips a segment to "dsl-parity" and points its `dsl`
// field here; the parity test then asserts dslSegmentBytes === golden. Keeping
// the declarations + their seed stores out of registry.ts leaves that file a
// pure status map.
//
// Each binding seeds a VariableStore from the SAME raw fixture inputs the legacy
// renderer reads (hook data, GitInfo, env) — never a pre-formatted value. The
// template does the formatting, so byte-parity proves the DSL can express the
// segment, not merely echo a baked string.
//
// [LAW:one-source-of-truth] bg/fg are the palette spec names that
// buildPaletteMapping(style="surface") assigns each segment's semantic variant.
// resolveSegmentColors runs them through the same PaletteResolver the legacy
// cascade uses, so the resolved RGBA (including fg auto-contrast) is identical.

import type { SegmentName } from "../../src/config/loader";
import type { DslBinding } from "./harness";
import { VariableStore } from "../../src/var-system/store";
import {
  HOOK_DATA,
  GIT_INFO,
  SESSION_ID,
  TMUX_SESSION_ID,
  ENV_VAR,
  THEME,
  USAGE_INFO,
  CONTEXT_INFO,
  METRICS_INFO,
  BLOCK_INFO,
  TODAY_INFO,
} from "./fixtures";

function seeded(seed: (s: VariableStore) => void): () => VariableStore {
  return () => {
    const s = new VariableStore();
    seed(s);
    return s;
  };
}

// $HOME (then $USERPROFILE) — the source legacy collapseHome reads. Read at
// store-creation time, not import time, so a test that mutates env before
// building the store is reflected.
function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

// Faithful "full"-style directory display, mirroring renderDirectory +
// getDisplayDirectoryName: (1) under a non-empty $HOME → "~"+remainder; (2) else
// under project_dir → project-relative path, falling back to the project
// basename only when the relative path is empty (current_dir === project_dir+"/");
// (3) else the full current_dir. The project-relative path is recomputed inline
// rather than bound once because the DSL rejects template-level `:=` (proposal:
// use the vars sub-block).
//
// The `ne .home ""` guard mirrors legacy's `if (home && …)`: hasPrefix with an
// empty prefix is vacuously true, so without the guard an unset $HOME would
// collapse every path to "~<path>".
const DIR_REL = 'trimPrefix "/" (trimPrefix .project_dir .current_dir)';
const DIR_TEMPLATE =
  " {{ if and (ne .home \"\") (hasPrefix .home .current_dir) }}~{{ trimPrefix .home .current_dir }}" +
  "{{ else }}" +
  "{{ if and (ne .project_dir .current_dir) (hasPrefix .project_dir .current_dir) }}" +
  `{{ ternary (${DIR_REL}) (basename .project_dir) (ne (${DIR_REL}) "") }}` +
  "{{ else }}{{ .current_dir }}{{ end }}{{ end }} ";

// Git working-tree counts have no clean DSL form without range/join: each count
// is conditionally present and the survivors join with single spaces. The
// leading-space-then-trim idiom expresses it — every present count contributes
// " +N", trim drops the leading space, so survivors end up single-spaced.
const GIT_WORKTREE =
  '{{ if or (gt .git.staged 0) (gt .git.unstaged 0) (gt .git.untracked 0) (gt .git.conflicts 0) }}' +
  ' ({{ printf "%s%s%s%s"' +
  ' (ternary (printf " +%v" .git.staged) "" (gt .git.staged 0))' +
  ' (ternary (printf " ~%v" .git.unstaged) "" (gt .git.unstaged 0))' +
  ' (ternary (printf " ?%v" .git.untracked) "" (gt .git.untracked 0))' +
  ' (ternary (printf " !%v" .git.conflicts) "" (gt .git.conflicts 0)) | trim }}){{ end }}';

// Status icon, in legacy's precedence order: conflicts → ⚠, dirty → ●, else
// clean ✓. status is a single enum value so the arms are mutually exclusive;
// the order mirrors renderGit for clarity. Nested if (the engine has no else-if).
const GIT_STATUS =
  '{{ if eq .git.status "conflicts" }}⚠{{ else }}' +
  '{{ if eq .git.status "dirty" }}●{{ else }}✓{{ end }}{{ end }}';

// repoName is optional in GitInfo; render it (plus its trailing space) only when
// present, matching renderGit's showRepoName && repoName guard.
const GIT_TEMPLATE =
  ' {{ if ne .git.repoName "" }}{{ .git.repoName }} {{ end }}⎇ {{ .git.branch }}' +
  '{{ if .git.sha }} ♯ {{ .git.sha }}{{ end }}' +
  '{{ if or (gt .git.ahead 0) (gt .git.behind 0) }}' +
  ' {{ if gt .git.ahead 0 }}↑{{ .git.ahead }}{{ end }}' +
  '{{ if gt .git.behind 0 }}↓{{ .git.behind }}{{ end }}{{ end }}' +
  GIT_WORKTREE +
  '{{ if .git.upstream }} →{{ .git.upstream }}{{ end }}' +
  '{{ if gt .git.stash 0 }} ⧇ {{ .git.stash }}{{ end }}' +
  ' ' +
  GIT_STATUS +
  ' ';

// [LAW:dataflow-not-control-flow] block and weekly share the same threshold
// cascade (80 = critical, 50 = warning, else default), differing only in the
// numeric variable that feeds the cascade. The bg/fg templates are factored
// to take a literal variable name so each segment's binding stays a single
// declaration — no clever runtime string surgery, just two named builders.
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

// [LAW:types-are-the-program] `satisfies` (not an annotation) keeps the
// constraint — keys must be SegmentNames, values must be DslBinding — while
// preserving the literal's keys as non-optional. So a registry entry that
// references DSL_BINDINGS.<seg> gets a guaranteed DslBinding (never
// `| undefined`), and a typo'd or missing key is a compile error rather than a
// silently-skipped parity assertion in the harness.
export const DSL_BINDINGS = {
  directory: {
    decl: { template: DIR_TEMPLATE, bg: "surface", fg: "foreground" },
    store: seeded((s) => {
      s.defineBox("current_dir", "string", HOOK_DATA.workspace.current_dir);
      s.defineBox("project_dir", "string", HOOK_DATA.workspace.project_dir);
      s.defineBox("home", "string", homeDir());
    }),
  },

  model: {
    // [LAW:one-source-of-truth] formatModelName (regex-based: strips
    // "(1M context)"-style decorations, canonicalizes raw IDs like
    // "claude-sonnet-4-6" → "Sonnet 4.6") is now wrapped by formatterFuncs
    // (chunk-7 bzh.5), so the DSL can express the same normalization the
    // legacy renderModel runs. Byte-identical to legacy for raw IDs AND
    // friendly names — model flips to dsl-parity in the registry.
    decl: {
      template: " ✱ {{ formatModelName .model.display_name }} ",
      bg: "panel",
      fg: "foreground",
    },
    store: seeded((s) => {
      s.defineBox("model.display_name", "string", HOOK_DATA.model.display_name);
    }),
  },

  sessionId: {
    decl: {
      template: " ⌗{{ trunc 8 .session.id }} ",
      bg: "surface",
      fg: "foreground",
    },
    store: seeded((s) => {
      s.defineBox("session.id", "string", SESSION_ID);
    }),
  },

  version: {
    // [LAW:dataflow-not-control-flow] renderVersion returns null when version is
    // absent; the DSL hides via `when`. Fixture provides version, so it renders.
    decl: {
      template: " ◈ v{{ .version }} ",
      bg: "surface",
      fg: "foreground",
      when: '{{ ne .version "" }}',
    },
    store: seeded((s) => {
      s.defineBox("version", "string", HOOK_DATA.version ?? "");
    }),
  },

  env: {
    // [LAW:dataflow-not-control-flow] Legacy renderEnv returns null when the
    // var is unset; the DSL hides via `when` (a value), not a body guard. The
    // fixture sets the var, so the segment still renders and matches golden.
    decl: {
      template: " ⚙ ENV: {{ .env.value }} ",
      bg: "surface-active",
      fg: "foreground",
      when: '{{ ne .env.value "" }}',
    },
    store: seeded((s) => {
      s.defineBox("env.value", "string", process.env[ENV_VAR] ?? "");
    }),
  },

  tmux: {
    // renderTmux shows "tmux:none" (not absence) for an empty session id; the
    // `default "none"` filter reproduces that. Fixture has a session id.
    decl: {
      template: ' tmux:{{ .tmux.session | default "none" }} ',
      bg: "surface-active",
      fg: "foreground",
    },
    store: seeded((s) => {
      s.defineBox("tmux.session", "string", TMUX_SESSION_ID);
    }),
  },

  git: {
    decl: { template: GIT_TEMPLATE, bg: "surface-active", fg: "foreground" },
    // Optional GitInfo fields seed to safe defaults ("" / 0); the template's
    // presence/`gt` guards decide what renders, mirroring how renderGit tolerates
    // unresolved fields. No non-null assertions on values that are legitimately
    // optional in production.
    store: seeded((s) => {
      s.defineBox("git.repoName", "string", GIT_INFO.repoName ?? "");
      s.defineBox("git.branch", "string", GIT_INFO.branch);
      s.defineBox("git.sha", "string", GIT_INFO.sha ?? "");
      s.defineBox("git.ahead", "number", GIT_INFO.ahead);
      s.defineBox("git.behind", "number", GIT_INFO.behind);
      s.defineBox("git.staged", "number", GIT_INFO.staged ?? 0);
      s.defineBox("git.unstaged", "number", GIT_INFO.unstaged ?? 0);
      s.defineBox("git.untracked", "number", GIT_INFO.untracked ?? 0);
      s.defineBox("git.conflicts", "number", GIT_INFO.conflicts ?? 0);
      s.defineBox("git.upstream", "string", GIT_INFO.upstream ?? "");
      s.defineBox("git.stash", "number", GIT_INFO.stashCount ?? 0);
      s.defineBox("git.status", "string", GIT_INFO.status);
    }),
  },

  // [LAW:single-enforcer] The toolbar binding emits OSC8-clickable items
  // through the canonical `link` template function (registered by rich-js).
  // Each top-level link is a separate cell with style.link set; cells.ts
  // splits at link boundaries and the rich-js serializer wraps each cell
  // in its OSC8 escape. Legacy renderToolbar pre-bakes OSC8 escape bytes
  // into a single segment's text via wrapOsc8; both producers end at
  // renderStripCells, and byte-parity verifies the multi-cell path emits
  // the same sequence the embedded form does.
  //
  // [LAW:dataflow-not-control-flow] The toolbar fixture has only non-extra
  // items (no `?` prefix), so the toolbar-expanded gate is data the test
  // does not exercise. A larger fixture (with extras) would gate via
  // `{{ if .toolbar.expanded }}…{{ end }}` reading the state.<key> var.
  //
  // URL encoding mirrors legacy: encodeURIComponent on every value.
  // session.id:8 in legacy maps to `trunc 8 .session.id`.
  toolbar: {
    decl: {
      template:
        ' {{ link (printf "cc-candybar://open-vscode/%s" (urlEncode .current_dir)) "\u{1F4C2}" }}' +
        ' {{ link (printf "cc-candybar://copy/%s" (urlEncode (trunc 8 .session.id))) "⎘" }} ',
      bg: "surface",
      fg: "foreground",
    },
    store: seeded((s) => {
      s.defineBox("session.id", "string", SESSION_ID);
      s.defineBox("current_dir", "string", HOOK_DATA.workspace.current_dir);
    }),
  },

  // [LAW:one-type-per-behavior] Tray is the toolbar with extras-gating
  // unconditionally off (see renderTray's comment). The DSL declaration
  // is therefore structurally identical to toolbar's; only the URL verbs
  // and visible glyphs differ.
  tray: {
    decl: {
      template:
        ' {{ link (printf "cc-candybar://open-url/%s" (urlEncode .theme)) "\u{1F514}" }}' +
        ' {{ link (printf "cc-candybar://copy/%s" (urlEncode (trunc 8 .session.id))) "⚙" }} ',
      bg: "surface",
      fg: "foreground",
    },
    store: seeded((s) => {
      s.defineBox("session.id", "string", SESSION_ID);
      s.defineBox("theme", "string", THEME);
    }),
  },

  // ─── chunk-7 bzh.5: usage / cost / time / locale family ─────────────
  // [LAW:one-source-of-truth] These bindings use formatterFuncs wrappers
  // (formatCost, formatTokens, round, formatLongTimeRemaining,
  // minutesUntilReset, formatInteger, formatResponseTime, formatDuration,
  // budgetStatus) — none re-implement formatting in template syntax.
  // Drift between DSL and legacy is impossible: both end at the same JS
  // function in src/utils/formatters.ts.

  // session — cost+tokens. Default config has no session budget.amount,
  // so the legacy formatUsageWithBudget appends "" (no suffix). The DSL
  // template omits budgetStatus entirely rather than calling it with a
  // zero-budget arg — both produce the same bytes for this fixture; if
  // a user config sets session.budget.amount, the template can grow a
  // budgetStatus call without changing this fixture.
  session: {
    decl: {
      template:
        " § {{ formatCost .session.cost }} ({{ formatTokens .session.tokens }}) ",
      bg: "surface",
      fg: "foreground",
    },
    store: seeded((s) => {
      s.defineBox("session.cost", "number", USAGE_INFO.session.cost ?? 0);
      s.defineBox("session.tokens", "number", USAGE_INFO.session.tokens ?? 0);
    }),
  },

  // today — cost+tokens with budget suffix. The fixture's DEFAULT_CONFIG
  // today.budget has amount=50, warningThreshold=80; cost=4.56 → "$4.56
  // (234.6K tokens) 9%". budgetStatus returns "" when budget=0, so the
  // template safely composes even when the user disables the budget.
  today: {
    decl: {
      template:
        " ☉ {{ formatCost .today.cost }} ({{ formatTokens .today.tokens }})" +
        "{{ budgetStatus .today.cost .today.budget.amount .today.budget.warningThreshold }} ",
      bg: "surface",
      fg: "foreground",
    },
    store: seeded((s) => {
      s.defineBox("today.cost", "number", TODAY_INFO.cost ?? 0);
      s.defineBox("today.tokens", "number", TODAY_INFO.tokens ?? 0);
      // Budget knobs come from PowerlineConfig.budget.today in production.
      // The DSL binding seeds them as scalars so the template doesn't have
      // to dereference a nested config object (var-system is flat-scalar).
      s.defineBox("today.budget.amount", "number", 50);
      s.defineBox("today.budget.warningThreshold", "number", 80);
    }),
  },

  // block — rounded pct + long-time-remaining, color-cascading on pct.
  // [LAW:dataflow-not-control-flow] Color thresholds are encoded in the
  // bg/fg template strings (which evaluate to palette spec names), not in
  // application code. The same data (round pct) decides text AND color;
  // no parallel branch for "compute color separately".
  // Palette mapping for fixture pct=55: warningThreshold=80, 50 <= pct < 80
  // → "warning" bg + "button-color-foreground" fg (matches legacy
  // contextWarningBg / contextWarningFg).
  block: {
    decl: {
      template:
        " ◱ {{ round .block.nativeUtilization }}% " +
        "({{ formatLongTimeRemaining .block.timeRemaining }}) ",
      bg: blockLikeBg(".block.nativeUtilization"),
      fg: blockLikeFg(".block.nativeUtilization"),
    },
    store: seeded((s) => {
      s.defineBox(
        "block.nativeUtilization",
        "number",
        BLOCK_INFO.nativeUtilization,
      );
      s.defineBox("block.timeRemaining", "number", BLOCK_INFO.timeRemaining);
    }),
  },

  // weekly — like block but resetsAt is epoch seconds, so the time chain
  // is `formatLongTimeRemaining (minutesUntilReset .resetsAt)` — exactly
  // the legacy composition. The legacy weekly thresholds are hardcoded
  // (80 critical, 50 warning), matching block's defaults — same BG/FG
  // template constants.
  weekly: {
    decl: {
      template:
        " ◑ {{ round .weekly.percentage }}% " +
        "({{ formatLongTimeRemaining (minutesUntilReset .weekly.resetsAt) }}) ",
      bg: blockLikeBg(".weekly.percentage"),
      fg: blockLikeFg(".weekly.percentage"),
    },
    store: seeded((s) => {
      s.defineBox(
        "weekly.percentage",
        "number",
        HOOK_DATA.rate_limits!.seven_day!.used_percentage,
      );
      s.defineBox(
        "weekly.resetsAt",
        "number",
        HOOK_DATA.rate_limits!.seven_day!.resets_at,
      );
    }),
  },

  // context — locale-grouped totalTokens + remaining-percentage, cascading
  // color on contextLeftPercentage. Color thresholds are INVERTED relative
  // to block/weekly: low "left" is critical (running out of context), high
  // "left" is normal. Default style for fixture's contextLeft=70 → context
  // segment colors ("surface-active" / "foreground"), matching variant=
  // warning under the surface preset.
  context: {
    decl: {
      template:
        " ◔ {{ formatInteger .context.totalTokens }} ({{ .context.contextLeft }}%) ",
      bg:
        "{{ if le .context.contextLeft 20 }}error" +
        "{{ else }}{{ if le .context.contextLeft 40 }}warning" +
        "{{ else }}surface-active{{ end }}{{ end }}",
      fg:
        "{{ if le .context.contextLeft 40 }}button-color-foreground" +
        "{{ else }}foreground{{ end }}",
    },
    store: seeded((s) => {
      s.defineBox("context.totalTokens", "number", CONTEXT_INFO.totalTokens);
      s.defineBox(
        "context.contextLeft",
        "number",
        CONTEXT_INFO.contextLeftPercentage,
      );
    }),
  },

  // metrics — all six parts (last-response, response, duration, messages,
  // lines-added, lines-removed) enabled. The fixture's MetricsInfo has all
  // non-null/positive values, so a static template renders byte-identical;
  // a user config that disables a part would need a more expressive
  // declaration — out of scope for the bzh.5 unblock. Variant=accent →
  // "panel" bg + "foreground" fg under the surface preset.
  metrics: {
    decl: {
      template:
        " Δ {{ formatResponseTime .metrics.lastResponseTime }}" +
        " ⧖ {{ formatResponseTime .metrics.responseTime }}" +
        " ⧗ {{ formatDuration .metrics.sessionDuration }}" +
        " ◆ {{ .metrics.messageCount }}" +
        " + {{ .metrics.linesAdded }}" +
        " - {{ .metrics.linesRemoved }} ",
      bg: "panel",
      fg: "foreground",
    },
    store: seeded((s) => {
      s.defineBox(
        "metrics.lastResponseTime",
        "number",
        METRICS_INFO.lastResponseTime ?? 0,
      );
      s.defineBox(
        "metrics.responseTime",
        "number",
        METRICS_INFO.responseTime ?? 0,
      );
      s.defineBox(
        "metrics.sessionDuration",
        "number",
        METRICS_INFO.sessionDuration ?? 0,
      );
      s.defineBox(
        "metrics.messageCount",
        "number",
        METRICS_INFO.messageCount ?? 0,
      );
      s.defineBox(
        "metrics.linesAdded",
        "number",
        METRICS_INFO.linesAdded ?? 0,
      );
      s.defineBox(
        "metrics.linesRemoved",
        "number",
        METRICS_INFO.linesRemoved ?? 0,
      );
    }),
  },
} satisfies Partial<Record<SegmentName, DslBinding>>;
