// [LAW:one-source-of-truth] The one way a test renders ONE bundled segment.

import type { ValidatedConfig } from "../../src/config/dsl-types";
import { rootOf } from "../../src/config/root";
import {
  EDIT_NS,
  EDIT_MODE_KEY,
  EDIT_TOGGLE_ACTION,
} from "../../src/config/loader/edit-mode";

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

// [LAW:locality-or-seam] Overriding `root` alone is not enough: edit-chrome
// synthesis bakes a copy of the full root and an addable-segment action into
// every preset, so the presets and their `edit.*` artifacts must go too.
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
