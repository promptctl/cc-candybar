import type { ActionDecl } from "./action.js";

const QUICK_ACTIONS = {
  copySession: { copy: "{{ .session.id }}" },
  copyResume: { copy: "{{ .resume_command }}" },
  openProject: { open: "{{ .project_dir }}" },
  openTranscript: { open: "{{ .transcript_path }}" },
  openConfig: { open: "{{ .config_path }}" },
} as const satisfies Record<string, ActionDecl>;

type QuickAction = keyof typeof QUICK_ACTIONS;

// [LAW:locality-or-seam] The glyph is the representation, the named action the
// behavior, the name the seam: one tray, instanced under any name prefix.
export function quickActions(prefix: string): {
  readonly template: string;
  readonly actions: Readonly<Record<string, ActionDecl>>;
} {
  const name = (action: QuickAction) => `${prefix}${action}`;
  return {
    // [LAW:dataflow-not-control-flow] `⎘ resume`, `↗ repo` and `↗ config`
    // are gated on their values: no workspace gives no resume command, a
    // local-only repo no page, and a bar on the bundled default no file, and
    // the glyph is absent.
    template:
      `{{ action "${name("copySession")}" "⎘ id" }}` +
      `{{ if ne .resume_command "" }} {{ action "${name("copyResume")}" "⎘ resume" }}{{ end }}` +
      ` {{ action "${name("openProject")}" "↗ proj" }}` +
      ` {{ action "${name("openTranscript")}" "↗ log" }}` +
      '{{ if ne .git.repoUrl "" }} {{ link .git.repoUrl "↗ repo" }}{{ end }}' +
      `{{ if ne .config_path "" }} {{ action "${name("openConfig")}" "↗ config" }}{{ end }}`,
    actions: Object.fromEntries(
      Object.entries(QUICK_ACTIONS).map(([action, decl]) => [
        `${prefix}${action}`,
        decl,
      ]),
    ),
  };
}
