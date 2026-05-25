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

import type { PaletteResolver } from "@promptctl/rich-js";
import type { SegmentRenderer } from "../../src/segments";
import type { PowerlineColors } from "../../src/themes";
import type { SegmentDecl } from "../../src/config/dsl-types";
import type { VariableStore } from "../../src/var-system/store";

import { buildLineStrip, renderStripCells } from "../../src/render/strip";
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

// [LAW:one-source-of-truth] The legacy bytes are produced by the *production*
// buildLineStrip — the same cell-padding + style lowering the daemon uses — so
// the golden cannot drift from real output if that lowering ever changes. No
// replica of toStripCell lives here.
export function legacySegmentBytes(
  render: LegacyRender,
  renderer: SegmentRenderer,
  colors: PowerlineColors,
): SegmentBytes {
  const data = render(renderer, colors);
  if (data === null) return null;
  return buildLineStrip(
    [{ type: "segment", text: data.text, bgHex: data.bgHex, fgHex: data.fgHex }],
    STRIP_OPTS,
  );
}

export function dslSegmentBytes(
  binding: DslBinding,
  resolver: PaletteResolver,
): SegmentBytes {
  // [LAW:one-source-of-truth] The binding owns its store; the caller cannot pass
  // a divergent one.
  const { decl } = binding;
  const store = binding.store();
  const engine = createCcCandybarEngine(resolver);
  const scope = buildScope(store);

  // [LAW:no-silent-fallbacks] Optional fields are tested for presence with
  // `!== undefined`, not truthiness — an explicit empty spec (bg: "" / fg: "" /
  // when: "") is a real value that must flow into the engine and fail loudly,
  // not be silently treated as "unset".
  const whenTpl = decl.when !== undefined ? engine.parse(decl.when) : undefined;
  if (!evaluateWhen(whenTpl, scope)) return null;

  const bgTpl = decl.bg !== undefined ? engine.parse(decl.bg) : undefined;
  const fgTpl = decl.fg !== undefined ? engine.parse(decl.fg) : undefined;
  const baseStyle = resolveSegmentColors(resolver, bgTpl, fgTpl, scope);

  // baseStyle layers under each fragment's own style (fragment wins on overlap),
  // so per-fragment fg (e.g. inline `{{ green "S" }}`) becomes a cell part with
  // its own fg under the segment bg — without baseStyle bleeding into a later
  // cell-rebuild that would drop parts.
  const fragments = engine.parse(decl.template).evaluate(scope);
  const cells = fragmentsToStripCells(fragments, baseStyle);

  // baseStyle also flows into layout so any synthesized pad/marker cells
  // for fixed-width segments inherit the segment bg+fg (Copilot finding on
  // bzh.6: without this, fixed-width segments would lose continuity and the
  // PowerlineJoiner would see a spurious bg transition into padding).
  const laidOut = applySegmentLayout(cells, {
    width: decl.width ?? "auto",
    justify: decl.justify ?? "left",
    truncate: decl.truncate ?? "right",
    baseStyle,
  });

  return renderStripCells(laidOut, STRIP_OPTS);
}

// ─── Golden store (committed canonical bytes) ────────────────────────────────

// Anchored at the package root via process.cwd(). Module-relative resolution
// (import.meta.url) is not usable here: test/ is excluded from the tsconfig that
// grants module:esnext, so ts-jest type-checks test files as CommonJS and
// rejects import.meta (TS1343), while __dirname is undefined at ESM runtime.
// `pnpm test` always runs jest from the package root, so cwd is stable.
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
