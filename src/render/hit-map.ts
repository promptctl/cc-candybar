// Where a pointer can act on a published frame: per line, the spans of cells
// that open a link, and the link each gesture opens there. The tmux bar pane
// hit-tests a mouse report against this and sends the daemon the link it finds
// (src/bar-pane), so it measures no cell and reads no escape sequence.
//
// [LAW:one-source-of-truth] Cells are measured by rich-js's cell width, the one
// the layout packed the frame with, so a span is where the layout put its run.
// [LAW:effects-at-boundaries] Pure over the frame.

import { cellLen } from "@promptctl/rich-js";
import { PLAIN_CLICK, type GestureName } from "../click/gesture.js";
import { isBarLink } from "../click/wire.js";
import type { Frame, Run } from "./frame.js";

// A span of cells [from, to), 0-based, on one line.
export interface Hit {
  readonly from: number;
  readonly to: number;
  // The action a template bound the region to, which hover names, or null for a
  // region drawn from a link alone.
  readonly action: string | null;
  // The signed link each gesture opens: the run's own link is the plain click.
  readonly links: Readonly<Record<GestureName, string>>;
}

// One list of hits per frame line, in line order.
export type HitMap = ReadonlyArray<readonly Hit[]>;

// [LAW:single-enforcer] Only a bar link goes to the daemon: a link of another
// scheme belongs to the terminal as drawn (frame-publication.ts), and the
// daemon refuses it.
const linksOf = (run: Run<string>): Hit["links"] | null =>
  run.link !== undefined && isBarLink(run.link)
    ? { [PLAIN_CLICK]: run.link, ...run.region?.gestures }
    : null;

const sameRegion = (a: Hit, links: Hit["links"], run: Run<string>): boolean =>
  a.action === (run.region?.name ?? null) &&
  Object.keys(a.links).length === Object.keys(links).length &&
  Object.entries(links).every(([gesture, link]) => a.links[gesture] === link);

export function hitMapOf(frame: Pick<Frame<string>, "rows">): HitMap {
  return frame.rows.map(({ runs }) => {
    const hits: Hit[] = [];
    let column = 0;
    for (const run of runs) {
      const to = column + cellLen(run.text);
      const links = linksOf(run);
      const last = hits.at(-1);
      if (links !== null) {
        if (
          last !== undefined &&
          last.to === column &&
          sameRegion(last, links, run)
        )
          hits[hits.length - 1] = { ...last, to };
        else
          hits.push({
            from: column,
            to,
            action: run.region?.name ?? null,
            links,
          });
      }
      column = to;
    }
    return hits;
  });
}
