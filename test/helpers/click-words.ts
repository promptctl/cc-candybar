// What a bar link says it does, and the long numbers those words may not hold.

import { effectsOf } from "../../src/click/read";
import {
  VERB_COPY,
  VERB_OPEN_VSCODE,
  VERB_REPO_CONFIG,
} from "../../src/click/wire";

const DISPATCH = "/dispatch/";

// The words a link says, as a hover's reader decodes them; empty on a link with
// none. The words are the first query param after the verb, so the first
// `/dispatch/` is the verb's: a later one is a path the words quote.
export const doesOf = (url: string): string => {
  const at = url.indexOf(DISPATCH);
  return at < 0
    ? ""
    : (new URLSearchParams(url.slice(at + DISPATCH.length)).get("does") ?? "");
};

// [LAW:one-source-of-truth] The verbs whose words quote text the machine holds
// (a copied text, a path to open, the directory a config answer names) rather
// than what the bar computed. Where a checkout lives, and where a harness keeps
// its scratch files, are in those words, and an agent worktree's name can hold
// any digits; so the case never reads them as numbers.
const QUOTES_THE_MACHINE: ReadonlySet<string> = new Set([
  VERB_COPY,
  VERB_OPEN_VSCODE,
  VERB_REPO_CONFIG,
]);

// The long numbers a link's words hold that the bar never shows: a timestamp or
// a raw counter a click says where a person would read a count or a page.
export const longNumbersSaid = (url: string): string[] =>
  effectsOf(url).some(({ verb }) => QUOTES_THE_MACHINE.has(verb))
    ? []
    : (doesOf(url).match(/\d{7,}/g) ?? []);
