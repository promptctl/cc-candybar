// [LAW:one-source-of-truth] The one way a test renders ONE bundled segment:
// narrow an already-validated config to that segment's leaf. Shared by every
// test that pins a single segment's bytes or colours.

import type {
  SettingValue,
  ValidatedConfig,
} from "../../src/config/dsl-types";
import { rootOf } from "../../src/config/root";
import {
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_KEY,
  EDIT_SWITCH,
  EDIT_TOGGLE_ACTION,
} from "../../src/config/loader/edit-mode";
import { EDIT_NS } from "../../src/config/loader/reserved-namespace";

// A canonical one-leaf vertical root — narrows a spread config to a single
// segment so the rendered line is exactly that segment's text.
export const oneSegmentRoot = (
  segment: string,
  settings?: Readonly<Record<string, SettingValue>>,
) => ({
  kind: "container" as const,
  direction: "vertical" as const,
  children: [
    {
      kind: "container" as const,
      direction: "horizontal" as const,
      children: [
        {
          kind: "segment" as const,
          name: segment,
          ...(settings !== undefined && { settings }),
        },
      ],
    },
  ],
});

// [LAW:locality-or-seam] Narrow an already-VALIDATED config to one segment.
// Overriding just `root` is not enough once the bundled default references
// `edit.toggle` (via the settings menu's `✎ arrange`):
// `synthesizeEditChrome` runs inside `parseAndValidate` — BEFORE any call
// site here narrows the layout — and, for every preset including the
// `"default"` floor, bakes a spliced copy of the FULL original root into
// `presets.default.root`. `registerDslConfig`'s per-preset compile prefers a
// preset's own `.root` over the top-level `root` field
// (`presetRoot`/`presets.ts`), so a bare `{ ...parsed, root: oneSegmentRoot(x) }`
// silently renders the untouched full tree instead of the narrowed one.
//
// Resetting `presets` alone isn't enough either: `synthesizeEditChrome` also
// bakes one `insertSegmentFrom` action per preset (`edit.addable.<name>`
// naming that preset's own addable-segment domain) into `config.actions`, and
// `registerDslConfig` compiles every declared action regardless of what's in
// `root` — so an orphaned reference to a domain only the now-discarded
// "compact"/"verbose" presets registered throws `unknown option domain`. None
// of this per-preset edit-chrome machinery is what these single-segment tests
// exercise (test/dsl-edit-mode.test.ts and test/dsl-layout-edit.test.ts own
// that surface), so the clean narrowing drops every synthesized per-preset
// `edit.*` chrome artifact too — EXCEPT the bare, preset-independent names the
// settings menu mints once (its `✎ arrange` fires EDIT_SWITCH, over the two
// keys), which stay so that control still compiles.
const MENU_EDIT_NAMES: ReadonlySet<string> = new Set([
  EDIT_MODE_KEY,
  EDIT_CONFIGURE_KEY,
  EDIT_TOGGLE_ACTION,
  ...EDIT_SWITCH,
]);
const EDIT_CHROME_NAME = (name: string) =>
  name.startsWith(EDIT_NS) && !MENU_EDIT_NAMES.has(name);

// Every record entry but the per-preset edit chrome — for a test narrowing a
// config its own way.
export const dropEditChrome = <V>(rec: Readonly<Record<string, V>>) =>
  Object.fromEntries(
    Object.entries(rec).filter(([name]) => !EDIT_CHROME_NAME(name)),
  );

export const narrowToSegment = (
  parsed: ValidatedConfig,
  segment: string,
  // The placement's own settings — set past the loader, so a test can hand
  // the render a pair the loader would refuse.
  settings?: Readonly<Record<string, SettingValue>>,
): ValidatedConfig => {
  return {
    ...parsed,
    root: rootOf(oneSegmentRoot(segment, settings)),
    presets: {},
    variables: dropEditChrome(parsed.variables),
    actions: dropEditChrome(parsed.actions),
    segments: dropEditChrome(parsed.segments),
  };
};
