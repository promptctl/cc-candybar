// [LAW:one-source-of-truth] The floor look, as a fixture's `EffectiveGlobals`
// and `RenderSelection` want it (brandon-looks-pe6). `globals.look` may hold an
// expression now, so the resolution crossing both seams is a `LookSelection`
// rather than a name — and a fixture that means "no look" says so once, here,
// instead of each file re-spelling the decided arm's shape and drifting from it
// when that shape changes.
import { decideLookName, type DecidedLook } from "../../src/themes";

export const FLOOR_LOOK: DecidedLook = decideLookName("none", {});
