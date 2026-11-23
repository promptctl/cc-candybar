// What a bar link says it does, and the long numbers those words may not hold.

import { clickOf, effectsOf } from "../../src/click/read";
import { isEffectVerb, saysOf } from "../../src/click/wire";

// The words a link says, as a hover's reader decodes them; empty on a link with
// none. A link the daemon would refuse throws.
export const doesOf = (url: string): string =>
  new URLSearchParams(clickOf(url).value).get("does") ?? "";

// The long numbers a link's words hold that the bar never shows: a timestamp or
// a raw counter a click says where a person would read a count or a page. What
// the words quote from outside the bar's computation (where a checkout lives,
// where a harness keeps its scratch files) is not the bar's number, whatever
// digits an agent worktree's name holds, so the face phrase is read without it.
export const longNumbersSaid = (url: string): string[] => {
  const [face] = saysOf(
    effectsOf(url).map(({ verb, args }) => {
      if (!isEffectVerb(verb)) throw new Error(`a link says verb ${verb}`);
      return { verb, args };
    }),
  );
  return (
    face?.words
      .split(face.quoted)
      .join("")
      .match(/\d{7,}/g) ?? []
  );
};
