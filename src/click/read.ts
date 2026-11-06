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
import { SEGMENTED_VERBS } from "../daemon/verbs";

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

// [LAW:one-source-of-truth] Decode an effect's value the way its daemon handler
// does, from the daemon's own list (src/daemon/verbs SEGMENTED_VERBS): those
// verbs' values are `/`-separated segments; every other verb takes ONE
// argument, the whole value decoded once, so a `copy/a/b` link reports one
// arg "a/b" (exactly what the copy handler copies).
function decodeArgs(verb: string, value: string): string[] {
  return SEGMENTED_VERBS.has(verb)
    ? decodeSegments(value)
    : [decodeURIComponent(value)];
}

export type DrawnClick =
  | { readonly ok: true; readonly effects: DecodedEffect[] }
  | { readonly ok: false; readonly problem: string };

// [LAW:parse-dont-validate] A drawn link's click as the daemon splits it, its
// ordered effects (a link whose verb is not dispatch is the one-effect case),
// or the reason the daemon refuses it: a config can compute a link at the
// draw that the parse refuses, or whose value carries a malformed escape.
export function drawnClickOf(url: string): DrawnClick {
  const link = parseHandlerUrl(url);
  if (!link.ok) return link;
  const { verb, value } = link;
  try {
    const effects =
      verb === VERB_DISPATCH
        ? parseEffects(value).map((e) => ({
            verb: e.verb,
            args: decodeArgs(e.verb, e.value),
          }))
        : [{ verb, args: decodeArgs(verb, value) }];
    return { ok: true, effects };
  } catch (error) {
    return {
      ok: false,
      problem: `the link's value does not decode (${(error as Error).message}): ${url}`,
    };
  }
}

// [LAW:no-silent-failure] A drawn link's effects, for a reader holding links
// the renderer itself wrote, so one the parse refuses is a bug in the draw,
// thrown here rather than carried as a refusal.
export function effectsOf(url: string): DecodedEffect[] {
  const click = drawnClickOf(url);
  if (!click.ok) throw new Error(click.problem);
  return click.effects;
}

/** The effects a click on `link` fires, `verb arg…` each, `;` between, or the parse's refusal; `sessionId` reads as `<session>`. */
export function describeLink(link: DrawnLink, sessionId: string): string {
  if (!isBarLink(link.url)) return `opens ${link.url}`;
  const click = drawnClickOf(link.url);
  if (!click.ok) return `refused: ${click.problem}`;
  return click.effects
    .map(({ verb, args }) =>
      [verb, ...args.map((a) => (a === sessionId ? "<session>" : a))].join(" "),
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
