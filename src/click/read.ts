// Reading a drawn Frame as clicks: every link it drew, the effects a click on
// each fires, and which of those act on the machine rather than the daemon. The
// drive-bar harness, the benchmark, and the page that runs the daemon in the
// browser (site/) read links through here, the one same way.

import type { Frame } from "../render/frame";
import {
  decodeSegments,
  parseEffects,
  parseHandlerUrl,
  VERB_APPLY_UPDATE,
  VERB_RUN,
  VERB_COPY,
  VERB_COPY_DIAGNOSTIC,
  VERB_DISPATCH,
  VERB_OPEN_VSCODE,
} from "./wire";
import { isBarLink } from "./scheme";
import { LEAF_VERB_NAMES, readClick, unknownVerb } from "../daemon/verbs";

/** One link the bar drew: its visible text and its URL. */
export interface DrawnLink {
  readonly text: string;
  readonly url: string;
}

/**
 * Every link a frame draws, by visible text, row by row. Runs of one URI with
 * nothing visible between them are one click target on the screen, whatever
 * look each drew in: a theme name's swatch, a cell of several runs.
 *
 * [LAW:dataflow-not-control-flow] A row is cut into stretches of one URI, the
 * stretches with none among them, and those fall away at the end.
 */
export function linksOf({ rows }: Pick<Frame, "rows">): DrawnLink[] {
  return rows.flatMap(({ runs }) => {
    const stretches: Array<{ url: string | undefined; text: string }> = [];
    for (const { link, text } of runs.filter((run) => run.text !== "")) {
      const last = stretches.at(-1);
      if (last !== undefined && last.url === link) last.text += text;
      else stretches.push({ url: link, text });
    }
    return stretches.flatMap(({ url, text }) =>
      url === undefined ? [] : [{ url, text: text.trim() }],
    );
  });
}

export interface DecodedEffect {
  readonly verb: string;
  readonly args: string[];
}

// One step of a drawn click, as the daemon reads it: one that runs, its
// arguments session first as the link spells them, or one refused, with the
// daemon's own text for why.
export type DrawnStep =
  | {
      readonly ok: true;
      readonly verb: string;
      readonly args: readonly string[];
    }
  | { readonly ok: false; readonly verb: string; readonly problem: string };

export type DrawnClick =
  | { readonly ok: true; readonly steps: readonly DrawnStep[] }
  | { readonly ok: false; readonly problem: string };

// A drawn link names `dispatch`: the one spelling of one that names anything
// else, for each reader that refuses it.
function namesNotDispatch(verb: string, url: string): string {
  return `a drawn link names ${VERB_DISPATCH}, and this names "${verb}": ${url}`;
}

// [LAW:parse-dont-validate] [LAW:one-source-of-truth] A drawn link's click as
// the daemon reads it, by the daemon's one read: its steps, adjacent writes as
// the one batch that lands, each that runs beside each refused with why. Or
// why the link does not read as a click at all: a config can compute a link at
// the draw that the parse refuses, and a link the bar draws names `dispatch`.
export function drawnClickOf(url: string): DrawnClick {
  const link = parseHandlerUrl(url);
  if (!link.ok) return link;
  const click = readClick(link.verb, link.value);
  if (click?.kind !== VERB_DISPATCH) {
    return { ok: false, problem: namesNotDispatch(link.verb, url) };
  }
  return {
    ok: true,
    steps: click.steps.map((step) =>
      step.ok
        ? { ok: true, verb: step.verb, args: [step.sid, ...step.args] }
        : { ok: false, verb: step.verb, problem: step.refusal.problem },
    ),
  };
}

// [LAW:no-silent-failure] A drawn link's effects as the link carries them,
// one per effect the renderer encoded, unbatched: the wire codec's inverse,
// for a test asserting what the renderer wrote, so a link that does not read
// is a bug in the draw, thrown here with the link. What a click on the link
// does is `drawnClickOf`'s to say.
export function effectsOf(url: string): DecodedEffect[] {
  const link = parseHandlerUrl(url);
  if (!link.ok) throw new Error(link.problem);
  if (link.verb !== VERB_DISPATCH) {
    throw new Error(namesNotDispatch(link.verb, url));
  }
  return parseEffects(link.value).map(({ verb, value }) => {
    if (!LEAF_VERB_NAMES.has(verb)) {
      throw new Error(`${unknownVerb(verb)}: ${url}`);
    }
    try {
      return { verb, args: decodeSegments(value) };
    } catch (error) {
      throw new Error(
        `the link's value does not decode (${(error as Error).message}): ${url}`,
        { cause: error },
      );
    }
  });
}

/** What a click on `link` does: a link not the bar's is the terminal's to open, and one that is runs `describeClick`'s steps. */
export function describeLink(link: DrawnLink, sessionId: string): string {
  return isBarLink(link.url)
    ? describeClick(drawnClickOf(link.url), sessionId)
    : `opens ${link.url}`;
}

/** The steps `click` runs, `verb arg…` each, a refused one as `refused: why`, `;` between, or the read's refusal; `sessionId` reads as `<session>`. */
export function describeClick(click: DrawnClick, sessionId: string): string {
  if (!click.ok) return `refused: ${click.problem}`;
  return click.steps
    .map((step) =>
      step.ok
        ? [
            step.verb,
            ...step.args.map((a) => (a === sessionId ? "<session>" : a)),
          ].join(" ")
        : `refused: ${step.problem}`,
    )
    .join(" ; ");
}

/**
 * The verbs whose handler acts on the machine outside the daemon, and what each
 * does there. A bar driven anywhere but a real session (the harness, the page)
 * does not send a click carrying one.
 *
 * The verbs that act through what the session REPORTS are not here, because a
 * driven bar reports an isolated machine: slash types into the tmux pane the
 * session's hint names (a driven bar either reports no pane, so the bar draws
 * no slash control, or names a socket no tmux server listens on, so the daemon
 * refuses the click), and doctor-fix writes the session's own Claude config
 * dir (an empty scratch dir for a driven bar). Their refusals are the bar's own, worth showing.
 */
export const HOST_VERBS: ReadonlyMap<string, string> = new Map([
  [VERB_COPY, "copies to the clipboard"],
  [VERB_COPY_DIAGNOSTIC, "copies a diagnostic to the clipboard"],
  [VERB_OPEN_VSCODE, "opens a file in VS Code"],
  [VERB_APPLY_UPDATE, "rebuilds cc-candybar"],
  [VERB_RUN, "runs a program the config declares"],
]);

// [LAW:single-enforcer] Why a bar driven anywhere but a real session does not
// send `click`, or null to send it: a step it runs acts on the machine. A
// refused step acts on nothing, so it never holds a click back: the daemon
// refuses it, as it refuses a real click. The reason names what each such
// step does, then the whole click, its refused steps included.
export function notSentOnDrivenBar(
  click: DrawnClick,
  sessionId: string,
): string | null {
  const acts = (click.ok ? click.steps : []).flatMap((step) => {
    const does = step.ok ? HOST_VERBS.get(step.verb) : undefined;
    return does === undefined ? [] : [does];
  });
  return acts.length === 0
    ? null
    : `not sent: on a real machine this ${acts.join(", ")}: ${describeClick(click, sessionId)}`;
}
