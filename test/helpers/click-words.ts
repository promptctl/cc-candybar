// What a bar link says it does, and the long numbers those words may not hold.

import { clickOf, effectsOf } from "../../src/click/read";
import { saysMachineText } from "../../src/click/wire";

// The words a link says, as a hover's reader decodes them; empty on a link with
// none. A link the daemon would refuse throws.
export const doesOf = (url: string): string =>
  new URLSearchParams(clickOf(url).value).get("does") ?? "";

// The long numbers a link's words hold that the bar never shows: a timestamp or
// a raw counter a click says where a person would read a count or a page. A
// phrase that quotes the machine's own text (where a checkout lives, where a
// harness keeps its scratch files) is not the bar's number, whatever digits an
// agent worktree's name holds.
export const longNumbersSaid = (url: string): string[] =>
  saysMachineText(effectsOf(url)) ? [] : (doesOf(url).match(/\d{7,}/g) ?? []);
