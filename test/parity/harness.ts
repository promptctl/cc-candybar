// [LAW:single-enforcer] Two producers, one verdict surface. legacySegmentBytes
// drives the shipped SegmentRenderer.render*; dslSegmentBytes drives the
// template-engine pipeline. Both end at renderStripCells — the same rich-js
// serializer the daemon uses — so "byte-identical" compares like with like.
//
// [LAW:verifiable-goals] The proof's "done" state has a concrete type: a byte
// string. Parity is `legacyBytes === dslBytes`; a gap is any inequality, which
// fails loudly rather than degrading.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { StripCell, Style } from "@promptctl/rich-js";
import type { PaletteResolver } from "@promptctl/rich-js";
import type { SegmentRenderer } from "../../src/segments";
import type { PowerlineColors } from "../../src/themes";
import type { SegmentDecl } from "../../src/config/dsl-types";
import type { VariableStore } from "../../src/var-system/store";

import { renderStripCells } from "../../src/render/strip";
import {
  createCcCandybarEngine,
  buildScope,
  fragmentsToStripCells,
  applySegmentLayout,
  resolveSegmentColors,
  evaluateWhen,
} from "../../src/template-engine";
import { STRIP_OPTS } from "./fixtures";

// A segment renders to a byte string, or `null` when the legacy renderer
// produces nothing (segment absent from the line). Both states are golden-able.
export type SegmentBytes = string | null;

// Closure that produces one segment's legacy SegmentData from the fixed fixture.
export type LegacyRender = (
  renderer: SegmentRenderer,
  colors: PowerlineColors,
) => { text: string; bgHex?: string; fgHex?: string } | null;

// The DSL counterpart for a segment: a declaration plus the store that supplies
// the variables its templates read. Present only once a segment is being
// migrated (bzh.1 / vhi.3 fill these in).
export interface DslBinding {
  decl: SegmentDecl;
  store: () => VariableStore;
}

// ─── Byte producers ──────────────────────────────────────────────────────────

export function legacySegmentBytes(
  render: LegacyRender,
  renderer: SegmentRenderer,
  colors: PowerlineColors,
): SegmentBytes {
  const data = render(renderer, colors);
  if (data === null) return null;
  return renderStripCells(
    [toLegacyCell(data.text, data.bgHex, data.fgHex)],
    STRIP_OPTS,
  );
}

// Mirror src/render/strip.ts toStripCell: one space of padding each side, bg/fg
// from the resolved hex. Imported indirectly via buildLineStrip would also work,
// but constructing the cell here keeps the legacy and DSL paths symmetric (both
// hand renderStripCells a StripCell[]).
function toLegacyCell(text: string, bgHex?: string, fgHex?: string): StripCell {
  return new StripCell(
    ` ${text} `,
    new Style({ bgcolor: bgHex || undefined, color: fgHex || undefined }),
  );
}

export function dslSegmentBytes(
  binding: DslBinding,
  store: VariableStore,
  resolver: PaletteResolver,
): SegmentBytes {
  const { decl } = binding;
  const engine = createCcCandybarEngine(resolver);
  const scope = buildScope(store);

  const whenTpl = decl.when ? engine.parse(decl.when) : undefined;
  if (!evaluateWhen(whenTpl, scope)) return null;

  const fragments = engine.parse(decl.template).evaluate(scope);
  const cells = fragmentsToStripCells(fragments);

  const bgTpl = decl.bg ? engine.parse(decl.bg) : undefined;
  const fgTpl = decl.fg ? engine.parse(decl.fg) : undefined;
  const defaultStyle = resolveSegmentColors(resolver, bgTpl, fgTpl, scope);

  const laidOut = applySegmentLayout(cells, {
    width: decl.width ?? "auto",
    justify: decl.justify ?? "left",
    truncate: decl.truncate ?? "right",
    defaultStyle,
  });

  return renderStripCells(laidOut, STRIP_OPTS);
}

// ─── Golden store (committed canonical bytes) ────────────────────────────────

const GOLDEN_PATH = join(process.cwd(), "test", "parity", "golden.json");

export type GoldenMap = Record<string, SegmentBytes>;

export function readGolden(): GoldenMap {
  if (!existsSync(GOLDEN_PATH)) {
    throw new Error(
      `parity golden missing at ${GOLDEN_PATH}. Generate it once with:\n` +
        `  CC_CANDYBAR_UPDATE_GOLDEN=1 pnpm test -- test/parity.test.ts`,
    );
  }
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenMap;
}

export function writeGolden(map: GoldenMap): void {
  // Sort keys so the committed file has a stable, reviewable diff.
  const sorted: GoldenMap = {};
  for (const key of Object.keys(map).sort()) sorted[key] = map[key]!;
  writeFileSync(GOLDEN_PATH, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

export const UPDATE_GOLDEN = process.env["CC_CANDYBAR_UPDATE_GOLDEN"] === "1";
