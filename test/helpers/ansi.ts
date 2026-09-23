// Reading a rendered line back: its visible text and its OSC-8 links.
//
// [LAW:one-source-of-truth] Every test reads rendered bytes through here, and
// this reads them through rich-js's `OSC8` grammar — the same one the bytes are
// written with — so a change to how a link is written is a change in one place,
// not in a regex copied into every file that clicks something.
import { OSC8 } from "@promptctl/rich-js";
import { INVISIBLE } from "../../src/render/ansi.js";

/** SGR + OSC 8: every escape that occupies no columns. */
export const ANSI = INVISIBLE;
export const stripAnsi = (s: string): string => s.replace(INVISIBLE, "");

export interface Link {
  readonly url: string;
  /** The raw bytes the link wraps, SGR included. */
  readonly text: string;
}

const osc8s = (rendered: string) => [...rendered.matchAll(new RegExp(OSC8.source, "g"))];

/** Each link in order: its URI and the bytes between its open and its close. */
export function links(rendered: string): Link[] {
  const out: Link[] = [];
  let open: RegExpExecArray | undefined;
  for (const m of osc8s(rendered)) {
    if (m[2] !== "") {
      open = m;
      continue;
    }
    if (open === undefined) throw new Error(`OSC 8 close at ${m.index} with no open link`);
    const from = open.index + open[0].length;
    out.push({ url: open[2]!, text: rendered.slice(from, m.index) });
    open = undefined;
  }
  return out;
}

/** The URI of every link open, in order — closed or not. */
export function linkUrls(rendered: string): string[] {
  return osc8s(rendered)
    .filter((m) => m[2] !== "")
    .map((m) => m[2]!);
}

/** How many link closes the bytes carry. */
export function linkCloseCount(rendered: string): number {
  return osc8s(rendered).filter((m) => m[2] === "").length;
}

/**
 * The URIs whose open immediately follows a bold SGR (`;1m`) — the renderer's
 * "current selection" marking.
 */
export function boldUrls(rendered: string): string[] {
  return [...rendered.matchAll(new RegExp(`;1m${OSC8.source}`, "g"))].map((m) => m[2]!);
}
