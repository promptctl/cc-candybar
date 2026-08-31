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
  VERB_CLEAR_STATE,
} from "../../src/click/wire";
import { VERBS } from "../../src/daemon/verbs";
import type { VerbContext } from "../../src/daemon/verbs";

export interface DecodedEffect {
  readonly verb: string;
  readonly args: string[];
}

// [LAW:one-source-of-truth] Decode an effect's value the SAME way the daemon's
// handler does, so the helper cannot mask a back-compat decode regression:
// set-state/step-state and their config-overrides twins set-config/step-config/
// reset-config are the multi-argument verbs (slash-segmented); every other verb
// takes ONE argument — the whole value decoded once — so a direct `copy/a/b`
// reports one arg "a/b" (exactly what the copy handler copies), not two.
const MULTI_ARG_VERBS = new Set<string>([
  VERB_SET_STATE,
  VERB_STEP_STATE,
  VERB_CLEAR_STATE,
  VERB_SET_CONFIG,
  VERB_STEP_CONFIG,
  VERB_RESET_CONFIG,
  VERB_UNDO,
  VERB_REDO,
  VERB_APPLY_LAYOUT_OP,
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

// Extract the URLs whose OSC-8 open is immediately preceded by a bold SGR
// (";1m") — the renderer's "current selection" marking.
export function boldUrls(rendered: string): string[] {
  const re = /;1m\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) out.push(m[1]!);
  return out;
}

// Drive a rendered click URL through the real parse → dispatch path.
export function clickUrl(url: string, ctx: VerbContext): void {
  const { verb, value } = parseHandlerUrl(url);
  const handler = VERBS.get(verb);
  if (!handler) throw new Error(`no handler for verb "${verb}"`);
  handler(value, ctx);
}
