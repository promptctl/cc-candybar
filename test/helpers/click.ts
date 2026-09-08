// Decode a rendered click URL to its effects and drive it through the REAL daemon path.

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
} from "../../src/click/wire";
import { VERBS } from "../../src/daemon/verbs";
import type { VerbContext } from "../../src/daemon/verbs";
import type { SessionStateRW } from "../../src/daemon/session-state";

// [LAW:one-source-of-truth] THE VerbContext a test hands the click path; its acts refuse loudly [LAW:no-silent-failure].
export function testVerbContext(sessionState: SessionStateRW): VerbContext {
  return {
    sessionState,
    dlog: () => {},
    applyUpdate: () => {
      throw new Error("apply-update: no update watch in this test");
    },
    doctor: {
      probeTmux: () => {
        throw new Error("doctor: no tmux edge in this test");
      },
      claudeSettingsPath: "/nonexistent/settings.json",
    },
  };
}

export interface DecodedEffect {
  readonly verb: string;
  readonly args: string[];
}

// [LAW:one-source-of-truth] Decode an effect's value the SAME way the daemon's handler does.
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
]);
function decodeArgs(verb: string, value: string): string[] {
  return MULTI_ARG_VERBS.has(verb)
    ? decodeSegments(value)
    : [decodeURIComponent(value)];
}

export function effectsOf(url: string): DecodedEffect[] {
  const { verb, value } = parseHandlerUrl(url);
  if (verb !== VERB_DISPATCH) return [{ verb, args: decodeArgs(verb, value) }];
  return parseEffects(value).map((e) => ({
    verb: e.verb,
    args: decodeArgs(e.verb, e.value),
  }));
}

// The renderer's "current selection" marking: an OSC-8 open preceded by a bold SGR.
export function boldUrls(rendered: string): string[] {
  const re = /;1m\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) out.push(m[1]!);
  return out;
}

export function clickUrl(url: string, ctx: VerbContext): void {
  const { verb, value } = parseHandlerUrl(url);
  const handler = VERBS.get(verb);
  if (!handler) throw new Error(`no handler for verb "${verb}"`);
  handler(value, ctx);
}
