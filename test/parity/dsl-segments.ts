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
import { HOOK_DATA, GIT_INFO, SESSION_ID, TMUX_SESSION_ID, ENV_VAR } from "./fixtures";

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
    // Reads the human-friendly model.display_name directly — the legitimate DSL
    // form for "show the model name". Legacy renderModel additionally runs
    // formatModelName (regex-based: strips "(1M context)"-style decorations,
    // canonicalizes raw IDs like "claude-sonnet-4-6" → "Sonnet 4.6"). That
    // normalization is NOT expressible in the DSL function set (no regex), so it
    // is filed as a capability gap (bzh.5), not faked by seeding a pre-formatted
    // value. For friendly display names (the common case + this fixture) the two
    // are byte-identical.
    decl: {
      template: " ✱ {{ .model.display_name }} ",
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
} satisfies Partial<Record<SegmentName, DslBinding>>;
