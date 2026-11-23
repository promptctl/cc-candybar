// [LAW:verifiable-goals] candybar-pre-migration-acxc.5o9: the click-words case
// (test/daemon-boots/worker/click-does.test.ts) holds a bar's links to saying no
// long number the bar never shows. It must give the same verdict wherever the
// checkout lives, and still catch such a number, so both sides are held here
// on links built the way the bar builds them.

import { doesOf, longNumbersSaid } from "../helpers/click-words";
import {
  effectsUrl,
  VERB_COPY,
  VERB_OPEN_VSCODE,
  VERB_REPO_CONFIG,
  VERB_SET_STATE,
} from "../../src/click/wire";

const SESSION = "11111111-2222-4333-8444-555555555555";
const CHECKOUT = "/work/agent-12345678-ab";

describe("the long numbers a link's words may not hold", () => {
  test("a number the bar never shows is named, wherever the checkout lives", () => {
    const stray = effectsUrl([
      { verb: VERB_SET_STATE, args: [SESSION, "retry", "1700000000000"] },
    ]);
    expect(longNumbersSaid(stray)).toEqual(["1700000000000"]);
  });

  test.each([
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

  test("a path that holds /dispatch/ does not cut the words short", () => {
    const url = effectsUrl([
      { verb: VERB_COPY, args: ["/Users/me/dispatch/cc-candybar"] },
    ]);
    expect(doesOf(url)).toBe("copy /Users/me/dispatch/cc-candybar");
  });
});
