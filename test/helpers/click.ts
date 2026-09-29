// Test helpers for the click wire. A rendered click URL is `dispatch/e=…` (an
// ordered effect list after the verb's `/`); these decode it to its behavioral
// content and drive it through the REAL daemon path, so assertions track "what
// effects does this click apply" rather than the exact wire encoding.

import { parseHandlerUrl } from "../../src/install/index";
import {
  parseEffects,
  decodeSegments,
  VERB_APPLY_LAYOUT_OP,
  VERB_DISPATCH,
  VERB_REDO,
  VERB_RESET_CONFIG,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_STEP_CONFIG,
  VERB_STEP_STATE,
  VERB_UNDO,
  VERB_DOCTOR_FIX,
  VERB_CEILING,
  VERB_SLASH,
} from "../../src/click/wire";
import {
  VERBS,
  SESSION_RENDER_ORIGIN_KEY,
  encodeRenderOrigin,
} from "../../src/daemon/verbs";
import type { VerbContext } from "../../src/daemon/verbs";
import type { SessionStateRW } from "../../src/daemon/session-state";
import { SettingsHistory } from "../../src/daemon/settings-history";
import type { DslConfig } from "../../src/config/dsl-types";

// The record a session's render leaves behind, which a click resolves its
// config from: a session only clicks links its own render drew.
export function recordRender(sessionState: SessionStateRW, sessionId: string): void {
  sessionState.set(
    sessionId,
    SESSION_RENDER_ORIGIN_KEY,
    encodeRenderOrigin({ projectDir: "/tmp/proj", cwd: "/tmp/proj", configFile: null }),
  );
}

// [LAW:one-source-of-truth] THE VerbContext a test hands the click path: a
// silent log and an update act that refuses loudly — no test here has an
// update watch, so an apply-update click reaching it is a test bug, never a
// silent no-op. [LAW:no-silent-failure]
// The history is ephemeral unless the caller hands one in: a test that is not
// isolated from the real state dir must never write the daemon's history file
// (test/helpers/durable-config.ts hands in one under its own temp root).
export function testVerbContext(
  sessionState: SessionStateRW,
  history: SettingsHistory = new SettingsHistory(sessionState, () => {}),
  config?: DslConfig,
): VerbContext {
  return {
    sessionState,
    history,
    dlog: () => {},
    applyUpdate: () => {
      throw new Error("apply-update: no update watch in this test");
    },
    // Same posture for the doctor's edge: a test that drives a doctor click
    // hands in its own fake edge; reaching this one is a test bug.
    doctor: {
      probeTmux: () => {
        throw new Error("doctor: no tmux edge in this test");
      },
    },
    // And for memento: a test that drives a ceiling click hands in its own.
    memento: {
      move: () => {
        throw new Error("ceiling: no memento provider in this test");
      },
    },
    // And for the Claude Code pane: a test that drives a slash click hands in
    // its own edge.
    claudeInput: {
      read: () => {
        throw new Error("slash: no claude-input edge in this test");
      },
      type: () => {
        throw new Error("slash: no claude-input edge in this test");
      },
    },
    // The config the session renders with: a test whose click reads it (a
    // save, a step from an unset key) hands it in; reaching the lookup
    // without one is a test bug.
    configFor: () => {
      if (config === undefined) {
        throw new Error("configFor: this test handed in no config");
      }
      return config;
    },
    // A reload rebuilds the render cache's entry from the file. This context
    // holds no render cache, so there is nothing to rebuild: the file a click
    // wrote is the whole outcome, and it is what these tests read. A rig with a
    // cache hands in its own — test/settings-config-menu.test.ts records each
    // reload to pin write → reload → release.
    reloadConfig: () => {},
  };
}

export interface DecodedEffect {
  readonly verb: string;
  readonly args: string[];
}

// [LAW:one-source-of-truth] Decode an effect's value the SAME way the daemon's
// handler does, so the helper cannot mask a back-compat decode regression:
// set-state/step-state and their config-file twins set-config/step-config/
// reset-config are the multi-argument verbs (slash-segmented); every other verb
// takes ONE argument — the whole value decoded once — so a direct `copy/a/b`
// reports one arg "a/b" (exactly what the copy handler copies), not two.
const MULTI_ARG_VERBS = new Set<string>([
  VERB_SET_STATE,
  VERB_STEP_STATE,
  VERB_SET_CONFIG,
  VERB_STEP_CONFIG,
  VERB_RESET_CONFIG,
  VERB_UNDO,
  VERB_REDO,
  VERB_APPLY_LAYOUT_OP,
  VERB_DOCTOR_FIX,
  VERB_CEILING,
  VERB_SLASH,
]);
function decodeArgs(verb: string, value: string): string[] {
  return MULTI_ARG_VERBS.has(verb)
    ? decodeSegments(value)
    : [decodeURIComponent(value)];
}

// Decode a rendered click URL into its ordered effect list (verb + decoded
// args). A direct (non-dispatch) URL is the degenerate one-effect case.
export function effectsOf(url: string): DecodedEffect[] {
  const { verb, value } = parseHandlerUrl(url);
  if (verb !== VERB_DISPATCH) return [{ verb, args: decodeArgs(verb, value) }];
  return parseEffects(value).map((e) => ({
    verb: e.verb,
    args: decodeArgs(e.verb, e.value),
  }));
}

export { boldUrls } from "./ansi";

// Drive a rendered click URL through the real parse → dispatch path.
export function clickUrl(url: string, ctx: VerbContext): void {
  const { verb, value } = parseHandlerUrl(url);
  const handler = VERBS.get(verb);
  if (!handler) throw new Error(`no handler for verb "${verb}"`);
  handler(value, ctx);
}
