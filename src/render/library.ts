// [LAW:one-source-of-truth] How a CATALOGUE option domain (`DomainLibrary`,
// src/config/option-domain.ts) lays out as a library: pure functions from the
// domain's own groups and entries to pages of sections of option indices, and
// from an entry to one row of text. The picker (src/render/picker.ts) is the
// one renderer; this module decides only WHAT stands on which page and HOW a
// row is fitted, so a library is data a domain declares, never a second picker.

import { RichText } from "@promptctl/rich-js";
import type { DomainLibrary } from "../config/option-domain.js";

// One group's members, in the order the domain lists them.
export interface LibrarySection {
  readonly label: string;
  readonly indices: readonly number[];
}

// A page is the sections it shows. Paged, each group is a page of its own and
// the ←/→ affordances turn through the groups; unpaged (the wrap case), one
// page holds every group.
export type LibraryPageLayout = readonly LibrarySection[];

// [LAW:no-silent-failure] A member whose entry names a group the domain never
// listed would vanish from every page — an option that exists for the click
// gate and nowhere on screen — so it is a loud error, not an omission.
export function libraryLayout(
  options: readonly string[],
  library: DomainLibrary,
  paged: boolean,
): readonly LibraryPageLayout[] {
  const sections = library.groups
    .map((group) => ({
      label: group.label,
      indices: options.flatMap((option, i) =>
        library.entry(option).group === group.id ? [i] : [],
      ),
    }))
    .filter((section) => section.indices.length > 0);
  const placed = sections.reduce((n, s) => n + s.indices.length, 0);
  if (placed !== options.length) {
    const known = new Set(library.groups.map((g) => g.id));
    const stray = options.filter((o) => !known.has(library.entry(o).group));
    throw new Error(
      `library: ${stray.map((o) => `"${o}" (group "${library.entry(o).group}")`).join(", ")} name a group the domain does not list (${[...known].join(", ")})`,
    );
  }
  return paged ? sections.map((section) => [section]) : [sections];
}

const ELLIPSIS = "…";
const cells = (text: string): number => new RichText(text).cellLength;

// [LAW:single-enforcer] Cut `text` to at most `width` terminal cells by the
// same cell measure the strip wraps by, closing with an ellipsis when it cut.
export function fitCells(text: string, width: number): string {
  if (cells(text) <= width) return text;
  const room = Math.max(0, width - cells(ELLIPSIS));
  let out = "";
  let used = 0;
  for (const ch of Array.from(text)) {
    const w = cells(ch);
    if (used + w > room) break;
    out += ch;
    used += w;
  }
  return out + ELLIPSIS;
}

// One library row: the member's name padded to the page's widest name so the
// descriptions align, then its description, fitted to the row. A member with no
// description is its bare name.
export function libraryRow(
  name: string,
  nameWidth: number,
  description: string | undefined,
  width: number,
): string {
  if (description === undefined) return fitCells(name, width);
  const gap = " ".repeat(Math.max(0, nameWidth - cells(name)) + 2);
  return fitCells(`${name}${gap}${description}`, width);
}
