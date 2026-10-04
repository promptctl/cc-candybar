// Reading a render's links: what each one says and what a click on it fires.
// Browser-safe (no node built-ins), so the drive-bar harness and the page that
// runs the daemon in the browser (site/) read links the one same way.

import { URL_SCHEME } from "../../src/click/wire";
import { links, stripAnsi } from "./ansi";
import { effectsOf } from "./click";

/** One link the bar drew: its visible text and every effect a click on it fires. */
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

/** The effects a click on `link` fires, `verb arg…` each, `;` between; `sessionId` reads as `<session>`. */
export function describeLink(link: DrawnLink, sessionId: string): string {
  if (!isBarLink(link.url)) return `opens ${link.url}`;
  return effectsOf(link.url)
    .map(({ verb, args }) =>
      [verb, ...args.map((a) => (a === sessionId ? "<session>" : a))].join(" "),
    )
    .join(" ; ");
}
