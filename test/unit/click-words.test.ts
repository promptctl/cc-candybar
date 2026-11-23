// [LAW:verifiable-goals] A bar's links may say no long number the bar never
// shows, and the verdict must be the same wherever the checkout lives. Both
// sides are held here on links built the way the bar builds them.

import { doesOf, longNumbersSaid } from "../helpers/click-words";
import {
  effectsUrl,
  type Effect,
  VERB_COPY,
  VERB_OPEN_VSCODE,
  VERB_REPO_CONFIG,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
} from "../../src/click/wire";

const SESSION = "11111111-2222-4333-8444-555555555555";
const CHECKOUT = "/work/agent-12345678-ab";
const STRAY = "1700000000000";

describe("the long numbers a link's words may not hold", () => {
  test("a number the bar never shows is named", () => {
    const stray = effectsUrl([
      { verb: VERB_SET_STATE, args: [SESSION, "retry", STRAY] },
    ]);
    expect(longNumbersSaid(stray)).toEqual([STRAY]);
  });

  test.each<[string, Effect]>([
    ["a copied path", { verb: VERB_COPY, args: [CHECKOUT] }],
    [
      "a path opened in an editor",
      { verb: VERB_OPEN_VSCODE, args: [CHECKOUT] },
    ],
    [
      "a directory a config answer names",
      { verb: VERB_REPO_CONFIG, args: [SESSION, CHECKOUT, "approved"] },
    ],
  ])("the machine's own text is not a number: %s", (_, effect) => {
    expect(longNumbersSaid(effectsUrl([effect]))).toEqual([]);
  });

  test("the verdict follows the phrase the link says, not the verbs it rides with", () => {
    const set: Effect = {
      verb: VERB_SET_CONFIG,
      args: [SESSION, "user", "retry", STRAY],
    };
    const copy: Effect = { verb: VERB_COPY, args: [CHECKOUT] };
    // The set is the face, so its number is said; the copy is only counted.
    expect(longNumbersSaid(effectsUrl([set, copy]))).toEqual([STRAY]);
    // The copy is the face, so the words quote the checkout and say no number.
    expect(longNumbersSaid(effectsUrl([copy, set]))).toEqual([]);
  });

  test("a path that holds /dispatch/ does not cut the words short", () => {
    const url = effectsUrl([
      { verb: VERB_COPY, args: ["/Users/me/dispatch/cc-candybar"] },
    ]);
    expect(doesOf(url)).toBe("copy /Users/me/dispatch/cc-candybar");
  });
});
