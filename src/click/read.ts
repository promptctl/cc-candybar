// Reading a rendered bar back as clicks: every link it drew, the effects a
// click on each fires, and which of those act on the machine rather than the
// daemon. The drive-bar harness, the tests, and the page that runs the daemon
// in the browser (site/) read links through here, the one same way.

import { osc8Sequences, type Osc8Sequence } from "@promptctl/rich-js";

import { INVISIBLE } from "../render/ansi";
import { parseHandlerUrl } from "../install/index";
import {
  decodeSegments,
  parseEffects,
  URL_SCHEME,
  VERB_APPLY_LAYOUT_OP,
  VERB_APPLY_UPDATE,
  VERB_CEILING,
  VERB_COPY,
  VERB_DISPATCH,
  VERB_DOCTOR_FIX,
  VERB_OPEN_VSCODE,
  VERB_REDO,
  VERB_RESET_CONFIG,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_SHOW_CONFIG_ERROR,
  VERB_SHOW_CONFIG_WARNING,
  VERB_SLASH,
  VERB_STEP_CONFIG,
  VERB_STEP_STATE,
  VERB_UNDO,
} from "./wire";

export const stripAnsi = (s: string): string => s.replace(INVISIBLE, "");

export interface Link {
  readonly url: string;
  /** The raw bytes the link wraps, SGR included. */
  readonly text: string;
}

/**
 * Each link in order: its URI and the bytes between its open and its close.
 *
 * [LAW:one-source-of-truth] Read through rich-js's `osc8Sequences`, over the
 * OSC 8 grammar the bytes are written with, so a change to how a link is
 * written is a change in one place.
 */
export function links(rendered: string): Link[] {
  const out: Link[] = [];
  let open: Osc8Sequence | undefined;
  for (const seq of osc8Sequences(rendered)) {
    if (seq.uri !== "") {
      // Rendered bytes close every link before the next opens; an open over
      // an open is the unclosed-link bleed, never a link to record.
      if (open !== undefined)
        throw new Error(
          `OSC 8 open at ${seq.index} while ${open.uri} is still open`,
        );
      open = seq;
      continue;
    }
    if (open === undefined)
      throw new Error(`OSC 8 close at ${seq.index} with no open link`);
    const from = open.index + open.length;
    out.push({ url: open.uri, text: rendered.slice(from, seq.index) });
    open = undefined;
  }
  if (open !== undefined)
    throw new Error(
      `OSC 8 open at ${open.index} (${open.uri}) is never closed`,
    );
  return out;
}

/** One link the bar drew: its visible text and its URL. */
export interface DrawnLink {
  readonly text: string;
  readonly url: string;
}

/** Every link `rendered` draws, by visible text. */
export function drawnLinks(rendered: string): DrawnLink[] {
  return links(rendered).map((l) => ({
    text: stripAnsi(l.text).trim(),
    url: l.url,
  }));
}

// A link outside the cc-candybar scheme (a repo page, a PR) is the
// terminal's to open; the daemon never sees a click on it.
export const isBarLink = (url: string): boolean =>
  url.startsWith(`${URL_SCHEME}://`);

export interface DecodedEffect {
  readonly verb: string;
  readonly args: string[];
}

// [LAW:one-source-of-truth] Decode an effect's value the SAME way the daemon's
// handler does: set-state/step-state and their config-file twins
// set-config/step-config/reset-config are the multi-argument verbs
// (slash-segmented); every other verb takes ONE argument — the whole value
// decoded once — so a direct `copy/a/b` reports one arg "a/b" (exactly what the
// copy handler copies), not two.
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

/** A click URL's ordered effect list (verb + decoded args); a direct URL is the one-effect case. */
export function effectsOf(url: string): DecodedEffect[] {
  const { verb, value } = parseHandlerUrl(url);
  if (verb !== VERB_DISPATCH) return [{ verb, args: decodeArgs(verb, value) }];
  return parseEffects(value).map((e) => ({
    verb: e.verb,
    args: decodeArgs(e.verb, e.value),
  }));
}

/** The effects a click on `link` fires, `verb arg…` each, `;` between; `sessionId` reads as `<session>`. */
export function describeLink(link: DrawnLink, sessionId: string): string {
  if (!isBarLink(link.url)) return `opens ${link.url}`;
  return effectsOf(link.url)
    .map(({ verb, args }) =>
      [verb, ...args.map((a) => (a === sessionId ? "<session>" : a))].join(" "),
    )
    .join(" ; ");
}

/**
 * The verbs whose handler acts on the machine outside the daemon, and what each
 * does there. A bar driven anywhere but a real session (the harness, the page)
 * does not send a click carrying one.
 */
export const HOST_VERBS: Readonly<Record<string, string>> = {
  [VERB_COPY]: "copies to the clipboard",
  [VERB_OPEN_VSCODE]: "opens a file in VS Code",
  [VERB_SHOW_CONFIG_ERROR]: "copies the config error",
  [VERB_SHOW_CONFIG_WARNING]: "copies the config warning",
  [VERB_APPLY_UPDATE]: "rebuilds cc-candybar",
};
