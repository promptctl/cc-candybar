// Reading a real daemon's diagnostics the way a person does: the indicator
// beside the settings door, a click on it, and the viewer paged with › until
// the last message, then ✕. Every click is found in the drawn frame by
// what it writes, never built, so the test clicks exactly what the bar drew.

import { plainOf, textOf, type Frame } from "../../src/render/frame";
import { linksOf } from "../../src/click/read";
import { DIAGNOSTICS_VIEWING } from "../../src/config/door";
import type { ClientHints } from "../../src/daemon/protocol";
import { effectsOf } from "./click";
import { click, render } from "./daemon-e2e";
import type { DaemonTarget } from "./daemon-wire";

// The indicator's text in a rendered bar (`⚠ N`), or null when it shows none.
export function indicatorOf(rendered: Frame): string | null {
  const link = viewerLink(rendered, "open");
  return link === undefined ? null : link.text;
}

// What a click on the viewer's key does: the indicator opens it, ‹ › page it,
// ✕ closes it.
export type ViewerControl = "open" | "‹" | "›" | "✕";

// The rendered link that writes the viewer's key as `control`: told apart by
// the text it wears, since each writes a message's key, not a position.
export function viewerLink(
  rendered: Frame,
  control: ViewerControl,
): { url: string; text: string } | undefined {
  return linksOf(rendered).find(
    ({ text, url }) =>
      (control === "open" ? text.startsWith("⚠") : text === control) &&
      effectsOf(url).some(
        (e) => e.verb === "set-state" && e.args[1] === DIAGNOSTICS_VIEWING,
      ),
  );
}

// One page of the viewer: its position and the message's text, its words
// joined by single spaces whatever rows they wrapped onto.
export interface ViewerPage {
  readonly position: string;
  readonly text: string;
  readonly rendered: Frame;
}

export function pageOf(rendered: Frame): ViewerPage {
  const [header = "", ...body] = rendered.rows.map(({ runs }) => plainOf(runs));
  const position = /\[(\d+\/\d+)\]/.exec(header)?.[1];
  if (position === undefined)
    throw new Error(`not the viewer: ${textOf(rendered)}`);
  return {
    position,
    text: body.join(" ").replace(/\s+/g, " ").trim(),
    rendered,
  };
}

// Every message a session's bar shows, read through the viewer: `bar` is the
// rendered bar whose indicator is clicked. Leaves the viewer closed. A bar
// already showing the viewer is refused: it has no indicator, and reading it
// as "no messages" hides whatever left the viewer open.
export async function readDiagnostics(
  target: DaemonTarget,
  sessionId: string,
  cwd: string,
  bar: Frame,
  hints: ClientHints = {},
  args: string[] = [],
): Promise<ViewerPage[]> {
  if (viewerLink(bar, "✕") !== undefined)
    throw new Error(`readDiagnostics: the viewer is already open on ${textOf(bar)}`);
  const open = viewerLink(bar, "open");
  if (open === undefined) return [];
  const draw = (): Promise<Frame> =>
    render(target, sessionId, cwd, hints, args);
  await click(target, open.url);
  const pages: ViewerPage[] = [];
  let shown = await draw();
  for (;;) {
    const page = pageOf(shown);
    pages.push(page);
    const [at, of] = page.position.split("/").map(Number);
    if (at! >= of!) break;
    await click(target, viewerLink(shown, "›")!.url);
    shown = await draw();
  }
  await click(target, viewerLink(shown, "✕")!.url);
  return pages;
}
