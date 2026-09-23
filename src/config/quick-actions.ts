import type { ActionDecl } from "./action.js";

export const QUICK_ACTIONS = {
  copySession: { copy: "{{ .session.id }}" },
  openProject: { open: "{{ .project_dir }}" },
  openTranscript: { open: "{{ .transcript_path }}" },
} as const satisfies Record<string, ActionDecl>;

export type QuickActionNames = Readonly<
  Record<keyof typeof QUICK_ACTIONS, string>
>;

export function toolbarTemplate(names: QuickActionNames): string {
  return (
    `{{ action "${names.copySession}" "⎘ id" }}` +
    ` {{ action "${names.openProject}" "↗ proj" }}` +
    ` {{ action "${names.openTranscript}" "↗ log" }}` +
    '{{ if ne .git.repoUrl "" }} {{ link .git.repoUrl "↗ repo" }}{{ end }}'
  );
}
