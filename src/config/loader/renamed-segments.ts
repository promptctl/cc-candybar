// [LAW:one-source-of-truth] The renamed built-in segments: old name → where it
// went. A user config merges on top of the bundled default, so an old name
// resolves to nothing, wherever it appears: a `root` entry, a `segments` delta,
// a tree-op `anchor`, a `segments.<name>.palette` target. Every one of those
// messages ends with `renamedHint`, so the migration pointer
// [LAW:no-silent-failure] reaches each reference path, not only the first one
// someone thought of. A future rename is one row here.
// A Map, not an object literal: an authored name is user data, and an object
// would answer `constructor` with Object.prototype's function.
//
// [LAW:types-are-the-program] A segment that moved into a plugin exists only
// once that plugin is installed, so its row names the source that installs it.
// One that left with no successor segment has nowhere to point, so its row
// carries no `to`, and says why instead.
type Renamed =
  | { readonly kind: "built-in"; readonly to: string }
  | { readonly kind: "plugin"; readonly to: string; readonly source: string }
  | { readonly kind: "removed"; readonly why: string };

export const RENAMED_SEGMENTS: ReadonlyMap<string, Renamed> = new Map<
  string,
  Renamed
>([
  ["gitTaculous", { kind: "built-in", to: "gitaculous" }],
  // The one-line summary became the collapsed form of `gitaculous`
  // (brandon-git-segment-ixf.tl0).
  ["git", { kind: "built-in", to: "gitaculous" }],
  // The settings menu's anchor left `settings.` so `.settings` could be a
  // placement's own settings (brandon-segment-settings-i4n).
  ["settings.menu", { kind: "built-in", to: "candybar.menu" }],
  // lit's ticket moved out of the bundled bar into the plugin lit's repository
  // ships, which reads lit's own statusline file (brandon-plugins-ktag.d6f).
  [
    "ticket",
    {
      kind: "plugin",
      to: "plugins.lit.ticket",
      source: "promptctl/links-issue-tracker",
    },
  ],
  [
    "ceiling",
    {
      kind: "removed",
      why: "the program it showed draws it through a cc-candybar plugin of its own now — delete this reference, or place that plugin's segment",
    },
  ],
  [
    "themeSwitcher",
    {
      kind: "removed",
      why: 'the settings menu\'s 🎨 theme control steps themes — delete this reference, or write your own `{{ carousel "apply" "open" "label" }}`',
    },
  ],
]);

export function renamedHint(name: string): string {
  const renamed = RENAMED_SEGMENTS.get(name);
  if (renamed === undefined) return "";
  switch (renamed.kind) {
    case "built-in":
      return ` (the built-in segment "${name}" was renamed to "${renamed.to}" — update this reference)`;
    case "plugin":
      return ` (the built-in segment "${name}" became "${renamed.to}", a segment of the plugin \`cc-candybar plugin install ${renamed.source}\` installs — update this reference)`;
    case "removed":
      return ` (the built-in segment "${name}" was removed: ${renamed.why})`;
  }
}
