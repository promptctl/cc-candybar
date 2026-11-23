// The state key of the menu a segment's placement hosts, for a test that
// reads or clicks it: the placement is identified by the preset whose tree is
// drawn, its id and its segment (src/config/placement-identity.ts). A segment
// placed bare has its own name as its id.

import { menuStateKey } from "../../src/config/menu-keys";

// The preset a rig draws when a test names none.
export const DRAWN_PRESET = "default";

export const menuKeyOf = (
  segment: string,
  apply: string,
  id: string = segment,
  preset: string = DRAWN_PRESET,
): string => menuStateKey({ preset, id, segment }, apply, undefined);
