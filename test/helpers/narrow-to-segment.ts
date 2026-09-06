// [LAW:one-source-of-truth] The one way a test renders ONE bundled segment:
// narrow an already-validated config to that segment's leaf. Shared by every
// test that pins a single segment's bytes or colours.

import type { ValidatedConfig } from "../../src/config/dsl-types";
import { rootOf } from "../../src/config/root";
import {
  EDIT_NS,
  EDIT_MODE_KEY,
  EDIT_TOGGLE_ACTION,
} from "../../src/config/loader/edit-mode";

// A canonical one-leaf vertical root — narrows a spread config to a single
// segment so the rendered line is exactly that segment's text.
export const oneSegmentRoot = (segment: string) => ({
  kind: "container" as const,
  direction: "vertical" as const,
  children: [
    {
      kind: "container" as const,
      direction: "horizontal" as const,
      children: [{ kind: "segment" as const, name: segment }],
    },
  ],
});

// [LAW:locality-or-seam] Narrow an already-VALIDATED config to one segment.
// Overriding just `root` is not enough once the bundled default references
// `edit.toggle` (brandon-layout-edit-2gc.4, via the toolbar segment):
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
// `edit.*` chrome artifact too — EXCEPT the two bare, preset-independent
// names (`edit.mode`/`edit.toggle`) Phase A synthesis writes once, which stay
// so a narrowed `toolbar` (whose template references `edit.toggle` directly)
// still compiles.
const EDIT_CHROME_NAME = (name: string) =>
  name.startsWith(EDIT_NS) &&
  name !== EDIT_MODE_KEY &&
  name !== EDIT_TOGGLE_ACTION;

export const narrowToSegment = (
  parsed: ValidatedConfig,
  segment: string,
): ValidatedConfig => {
  const dropEditChrome = <V>(rec: Readonly<Record<string, V>>) =>
    Object.fromEntries(
      Object.entries(rec).filter(([name]) => !EDIT_CHROME_NAME(name)),
    );
  return {
    ...parsed,
    root: rootOf(oneSegmentRoot(segment)),
    presets: {},
    variables: dropEditChrome(parsed.variables),
    actions: dropEditChrome(parsed.actions),
    segments: dropEditChrome(parsed.segments),
  };
};
