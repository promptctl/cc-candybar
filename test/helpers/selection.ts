// [LAW:one-source-of-truth] A RenderSelection as the daemon resolves it:
// `resolveEffectiveGlobals` over the session's picks (none by default — a
// session that has never clicked), with `over`'s fields in place of the ones a
// fixture builds itself (a decided palette or style no name installs, an
// effect memory). A fixture states only what it varies; every other field is
// the config's own, read the one way the bar reads it.
import type { DslConfig } from "../../src/config/dsl-types";
import { resolveEffectiveGlobals } from "../../src/config/effective-globals";
import type { RenderSelection } from "../../src/dsl/render";

export const selectionFor = (
  config: DslConfig,
  over: Partial<RenderSelection> = {},
  sessionPick: (key: string) => string | null = () => null,
): RenderSelection => ({
  ...resolveEffectiveGlobals(config, sessionPick, () => false),
  ...over,
});

// The session-pick reader for a fixed set of picks, as SessionState would answer.
export const picked =
  (picks: Readonly<Record<string, string>>) =>
  (key: string): string | null =>
    picks[key] ?? null;
