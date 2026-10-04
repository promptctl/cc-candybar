// Reading a rendered line back: its visible text and its OSC-8 links.
//
// [LAW:one-source-of-truth] Every test reads rendered bytes through here, and
// this reads them through rich-js's `osc8Sequences`, over the OSC 8 grammar — the same one the bytes are
// written with — so a change to how a link is written is a change in one place,
// not in a regex copied into every file that clicks something. `links` and
// `stripAnsi` are src/click/read.ts's, which the page in site/ reads with too.
import { resolvedStyle } from "../../src/template-engine/cells.js";
import { decodeAnsi, osc8Sequences } from "@promptctl/rich-js";
import { INVISIBLE } from "../../src/render/ansi.js";
import { links, stripAnsi, type Link } from "../../src/click/read";

/** SGR + OSC 8: every escape that occupies no columns. */
export { INVISIBLE, links, stripAnsi, type Link };

/** The bytes with every OSC 8 open and close removed, SGR kept: what a
 *  rendered line looks like, apart from where its clicks go (a link names the
 *  session it was rendered for). */
export function withoutLinks(rendered: string): string {
  let out = "";
  let from = 0;
  for (const seq of osc8Sequences(rendered)) {
    out += rendered.slice(from, seq.index);
    from = seq.index + seq.length;
  }
  return out + rendered.slice(from);
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
 * The URI of every link drawn bold — the renderer's "current selection"
 * marking — once per link, in order.
 *
 * Read through rich-js's `decodeAnsi`, the inverse of the writer, so where
 * bold sits among an SGR's parameters is the writer's business (0.18 moved it
 * from last to first and a byte match went blind).
 */
export function boldUrls(rendered: string): string[] {
  const out: string[] = [];
  let run: { link: string; end: number } | undefined;
  for (const { start, end, style } of decodeAnsi(rendered).spans) {
    const { link, bold } = resolvedStyle(style);
    if (link === undefined) {
      run = undefined;
      continue;
    }
    // A link whose cells change style decodes as adjacent spans; the first
    // decides, as the open's own SGR did.
    const continues = run?.link === link && run.end === start;
    if (!continues && bold === true) out.push(link);
    run = { link, end };
  }
  return out;
}
