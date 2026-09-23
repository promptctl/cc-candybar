import type { ActionDecl } from "./action.js";

const QUICK_ACTIONS = {
  copySession: { copy: "{{ .session.id }}" },
  openProject: { open: "{{ .project_dir }}" },
  openTranscript: { open: "{{ .transcript_path }}" },
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
    // [LAW:dataflow-not-control-flow] `↗ repo` is gated on the value: a
    // local-only repo supplies no page and the glyph is absent.
    template:
      `{{ action "${name("copySession")}" "⎘ id" }}` +
      ` {{ action "${name("openProject")}" "↗ proj" }}` +
      ` {{ action "${name("openTranscript")}" "↗ log" }}` +
      '{{ if ne .git.repoUrl "" }} {{ link .git.repoUrl "↗ repo" }}{{ end }}',
    actions: Object.fromEntries(
      Object.entries(QUICK_ACTIONS).map(([action, decl]) => [
        `${prefix}${action}`,
        decl,
      ]),
    ),
  };
}
