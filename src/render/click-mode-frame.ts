// The one step that gives a drawn frame the links its lane's click mode means
// (src/config/click-mode.ts). A cell is drawn once, and the mode is the draw's:
// the session's, unless the surface of the follower that owns the pointer (a
// link's surface, with none) delivers the mode's gesture itself. So no cell reads
// the mode: each region carries what a click means in every mode, and the frame's
// links are picked here, after the draw. While a lane draws the bar elsewhere,
// the statusline shows the handoff line, which has no regions.

import { MODE_GESTURE, type ClickMode } from "../config/click-mode.js";
import type { DrawnAction, DrawnEffect } from "./drawn-link.js";
import { actionTarget } from "./drawn-link.js";
import type { Frame, Run } from "./frame.js";

type Region = NonNullable<DrawnAction["region"]>;

// [LAW:dataflow-not-control-flow] What a click on a region runs, by mode, as
// data. Undefined is no binding, and the region is drawn with no link.
const CLICK_OF: Readonly<
  Record<
    ClickMode,
    (link: DrawnAction, region: Region) => readonly DrawnEffect[] | undefined
  >
> = {
  click: (link) => link.effects,
  hover: (_link, region) => region.hover,
  alt: (_link, region) => region.gestures[MODE_GESTURE.alt],
};

function runIn(run: Run, mode: ClickMode): Run {
  const { link } = run;
  // A link no action names (a menu's own rows, a picker's option, an authored
  // href) is not a region, and is the same link in every mode.
  if (
    link === undefined ||
    typeof link === "string" ||
    link.kind !== "action" ||
    link.region === undefined
  )
    return run;
  const { region } = link;
  const effects = CLICK_OF[mode](link, region);
  if (effects === undefined) {
    // [LAW:no-silent-failure] A region with no binding for the mode draws no
    // link, so a click on it runs nothing rather than what the mode does not
    // mean.
    const { link: _dropped, ...bare } = run;
    return bare;
  }
  // The hover binding has done its work: what a lane publishes of a region is
  // its name and the gestures a follower delivers.
  return {
    ...run,
    link: actionTarget(effects, link.description, {
      name: region.name,
      gestures: region.gestures,
    }),
  };
}

export function inClickMode(frame: Frame, mode: ClickMode): Frame {
  return {
    ...frame,
    rows: frame.rows.map((row) => ({
      ...row,
      runs: row.runs.map((run) => runIn(run, mode)),
    })),
  };
}
