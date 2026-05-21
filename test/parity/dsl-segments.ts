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

// Status icon: dirty → ●, conflicts → ⚠, else clean ✓. Nested if (no else-if).
const GIT_STATUS =
  '{{ if eq .git.status "dirty" }}●{{ else }}' +
  '{{ if eq .git.status "conflicts" }}⚠{{ else }}✓{{ end }}{{ end }}';

const GIT_TEMPLATE =
  ' {{ .git.repoName }} ⎇ {{ .git.branch }}' +
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

export const DSL_BINDINGS: Partial<Record<SegmentName, DslBinding>> = {
  directory: {
    decl: {
      template: ' {{ trimPrefix "/" (trimPrefix .project_dir .current_dir) }} ',
      bg: "surface",
      fg: "foreground",
    },
    store: seeded((s) => {
      s.defineBox("current_dir", "string", HOOK_DATA.workspace.current_dir);
      s.defineBox("project_dir", "string", HOOK_DATA.workspace.project_dir);
    }),
  },

  model: {
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
    decl: {
      template: " ◈ v{{ .version }} ",
      bg: "surface",
      fg: "foreground",
    },
    store: seeded((s) => {
      s.defineBox("version", "string", HOOK_DATA.version!);
    }),
  },

  env: {
    decl: {
      template: " ⚙ ENV: {{ .env.value }} ",
      bg: "surface-active",
      fg: "foreground",
    },
    store: seeded((s) => {
      s.defineBox("env.value", "string", process.env[ENV_VAR] ?? "");
    }),
  },

  tmux: {
    decl: {
      template: " tmux:{{ .tmux.session }} ",
      bg: "surface-active",
      fg: "foreground",
    },
    store: seeded((s) => {
      s.defineBox("tmux.session", "string", TMUX_SESSION_ID);
    }),
  },

  git: {
    decl: { template: GIT_TEMPLATE, bg: "surface-active", fg: "foreground" },
    store: seeded((s) => {
      s.defineBox("git.repoName", "string", GIT_INFO.repoName!);
      s.defineBox("git.branch", "string", GIT_INFO.branch);
      s.defineBox("git.sha", "string", GIT_INFO.sha!);
      s.defineBox("git.ahead", "number", GIT_INFO.ahead);
      s.defineBox("git.behind", "number", GIT_INFO.behind);
      s.defineBox("git.staged", "number", GIT_INFO.staged!);
      s.defineBox("git.unstaged", "number", GIT_INFO.unstaged!);
      s.defineBox("git.untracked", "number", GIT_INFO.untracked!);
      s.defineBox("git.conflicts", "number", GIT_INFO.conflicts!);
      s.defineBox("git.upstream", "string", GIT_INFO.upstream!);
      s.defineBox("git.stash", "number", GIT_INFO.stashCount!);
      s.defineBox("git.status", "string", GIT_INFO.status);
    }),
  },
};
