// Reading a rendered line back: its visible text and its OSC-8 links.
//
// [LAW:one-source-of-truth] Every test reads rendered bytes through here, and
// this reads them through rich-js's `osc8Sequences`, over the OSC 8 grammar — the same one the bytes are
// written with — so a change to how a link is written is a change in one place,
// not in a regex copied into every file that clicks something.
import { osc8Sequences, type Osc8Sequence } from "@promptctl/rich-js";
import { INVISIBLE } from "../../src/render/ansi.js";

/** SGR + OSC 8: every escape that occupies no columns. */
export const ANSI = INVISIBLE;
export const stripAnsi = (s: string): string => s.replace(INVISIBLE, "");

export interface Link {
  readonly url: string;
  /** The raw bytes the link wraps, SGR included. */
  readonly text: string;
}

/** Each link in order: its URI and the bytes between its open and its close. */
export function links(rendered: string): Link[] {
  const out: Link[] = [];
  let open: Osc8Sequence | undefined;
  for (const seq of osc8Sequences(rendered)) {
    if (seq.uri !== "") {
      open = seq;
      continue;
    }
    if (open === undefined) throw new Error(`OSC 8 close at ${seq.index} with no open link`);
    const from = open.index + open.length;
    out.push({ url: open.uri, text: rendered.slice(from, seq.index) });
    open = undefined;
  }
  return out;
}

/** The URI of every link open, in order — closed or not. */
export function linkUrls(rendered: string): string[] {
  return osc8Sequences(rendered)
    .filter((seq) => seq.uri !== "")
    .map((seq) => seq.uri);
}

/** How many link closes the bytes carry. */
export function linkCloseCount(rendered: string): number {
  return osc8Sequences(rendered).filter((seq) => seq.uri === "").length;
}

/**
 * The URIs whose open immediately follows a bold SGR (`;1m`) — the renderer's
 * "current selection" marking.
 */
export function boldUrls(rendered: string): string[] {
  return osc8Sequences(rendered)
    .filter((seq) => seq.uri !== "" && rendered.slice(seq.index - 3, seq.index) === ";1m")
    .map((seq) => seq.uri);
}
