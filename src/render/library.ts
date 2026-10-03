// [LAW:one-source-of-truth] How a CATALOGUE option domain (`DomainLibrary`,
// src/config/option-domain.ts) lays out as a library: pure functions from the
// domain's own groups and entries to pages of sections of option indices, and
// from an entry to one row of text. The picker (src/render/picker.ts) is the
// one renderer; this module decides only WHAT stands on which page and HOW a
// row is fitted, so a library is data a domain declares, never a second picker.

import { RichText } from "@promptctl/rich-js";
import type { LibraryEntry, LibraryGroup } from "../config/option-domain.js";

// One group's members, in the order the domain lists them.
export interface LibrarySection {
  readonly label: string;
  readonly indices: readonly number[];
}

// A page is the sections it shows. Paged, each group is a page of its own and
// the ←/→ affordances turn through the groups; unpaged (the wrap case), one
// page holds every group.
export type LibraryPageLayout = readonly LibrarySection[];

// [LAW:no-mode-explosion] The most members one paged page holds. A paged
// picker's promise is that a page FITS: a grid page fits the width, and a
// library page, one row per member, must fit the height too, so a group larger
// than this turns over onto further pages of the same group (`other 3/9`). The
// bundled groups each fit on one page; the cap is reached only by a config that
// files many segments under one group.
export const LIBRARY_PAGE_ROWS = 8;

// [LAW:no-silent-failure] A member whose entry names a group the domain never
// listed would vanish from every page — an option that exists for the click
// gate and nowhere on screen — so it is a loud error, not an omission. The
// registry seam is generic over a domain's group ids, so this is its one
// enforcer; the one catalogue today types its entries over its own closed ids.
// `entries` is the domain's `entry` of every option, in option order, taken
// once by the caller.
export function libraryLayout(
  entries: readonly LibraryEntry[],
  groups: readonly LibraryGroup[],
  paged: boolean,
): readonly LibraryPageLayout[] {
  const sections = groups
    .map((group) => ({
      label: group.label,
      indices: entries.flatMap((entry, i) =>
        entry.group === group.id ? [i] : [],
      ),
    }))
    .filter((section) => section.indices.length > 0);
  const placed = sections.reduce((n, s) => n + s.indices.length, 0);
  if (placed !== entries.length) {
    const known = new Set(groups.map((g) => g.id));
    const stray = entries.flatMap((entry, i) =>
      known.has(entry.group) ? [] : [`#${i} (group "${entry.group}")`],
    );
    throw new Error(
      `library: ${stray.join(", ")} name a group the domain does not list (${[...known].join(", ")})`,
    );
  }
  return paged
    ? sections.flatMap((section) =>
        chunk(section.indices, LIBRARY_PAGE_ROWS).map((indices) => [
          { label: section.label, indices },
        ]),
      )
    : [sections];
}

function chunk<T>(items: readonly T[], size: number): readonly T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, n) =>
    items.slice(n * size, (n + 1) * size),
  );
}

// [LAW:single-enforcer] Cut `text` to at most `width` terminal cells through
// rich-js's own truncation — the cell algebra the strip wraps by, which cuts
// only between grapheme clusters — closing with an ellipsis when it cut.
export function fitCells(text: string, width: number): string {
  return new RichText(text).truncate(width, { marker: "…" }).plain;
}
