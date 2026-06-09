// Test helpers for the click wire. A rendered click URL is `dispatch/e=…` (an
// ordered effect list after the verb's `/`); these decode it to its behavioral
// content and drive it through the REAL daemon path, so assertions track "what
// effects does this click apply" rather than the exact wire encoding.

import { parseHandlerUrl } from "../../src/install/index";
import {
  parseEffects,
  decodeSegments,
  VERB_DISPATCH,
  VERB_SET_STATE,
  VERB_STEP_STATE,
} from "../../src/click/wire";
import { VERBS } from "../../src/daemon/verbs";
import type { VerbContext } from "../../src/daemon/verbs";

export interface DecodedEffect {
  readonly verb: string;
  readonly args: string[];
}

// [LAW:one-source-of-truth] Decode an effect's value the SAME way the daemon's
// handler does, so the helper cannot mask a back-compat decode regression:
// set-state and step-state are the multi-argument verbs (slash-segmented); every
// other verb takes ONE argument — the whole value decoded once — so a direct
// `copy/a/b` reports one arg "a/b" (exactly what the copy handler copies), not two.
function decodeArgs(verb: string, value: string): string[] {
  return verb === VERB_SET_STATE || verb === VERB_STEP_STATE
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
