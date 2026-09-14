// [LAW:one-source-of-truth] THE close affordance every row of an open
// disclosure body leads with (brandon-disclosure-43z): one ✕ whose click
// writes the disclosure's state key back to the closed sentinel — the same
// (key, closed) pair the trigger's own open-state glyph writes and the same
// value its synthesized `cycle` action gates (`deriveActionValidators`), so the
// row's ✕ needs no verb, no action name and no gate of its own. It is the
// `opens`-body twin of the ✕ a `{{ menu }}`'s picker leads with (render/
// picker.ts): that one also resets the page cursor because a picker pages; a
// body does not, so this write is the pair alone.
//
// [LAW:effects-at-boundaries] A pure description — a link span carrying the
// click URL — built from the store's session id; the click itself happens in
// the daemon's verb handler like every other affordance on the bar.

import type { RichText } from "@promptctl/rich-js";
import type { VariableStore } from "../var-system/store.js";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSE,
} from "../config/disclosure.js";
import { effectsUrl, VERB_SET_STATE } from "../click/wire.js";
import { linkFragment, readVar } from "./action.js";

export function disclosureCloseFragment(
  store: VariableStore,
  key: string,
): RichText {
  return linkFragment(
    DISCLOSURE_GLYPH_CLOSE,
    effectsUrl([
      {
        verb: VERB_SET_STATE,
        args: [readVar(store, "session.id"), key, DISCLOSURE_CLOSED],
      },
    ]),
    false,
  );
}
