// [LAW:single-enforcer] THE node-type registry: the one place each layout node
// kind's render-time behavior (compile + render) is defined, dispatched through a
// single typed lookup. Generalizes the former hand-coded kind:container|cells|
// inline if-chains in render.ts into a registry keyed by `LayoutNode["kind"]`.
//
// [LAW:one-type-per-behavior] container, cells, inline, and a composite like
// stepper all have the SAME behavior — render a subtree of lines-of-cells from
// (node, ctx). So they are ONE contract with a registry, not a base-substrate
// layer plus a separate component layer. The walk is ONE uniform dispatch:
// nodeType(node.kind).render(node, ctx). A composite's render returns MORE nodes
// by handing them to ctx.renderChild (the walk continues into them), exactly as a
// React function-component returns host elements — it never serializes itself.
//
// [LAW:one-way-deps] This module sits BELOW render.ts (the driver): it imports
// the leaf render/template helpers directly and receives the two recursive
// capabilities (compileChild, renderChild) + the hue counter as DATA from the
// driver. It must NOT import render.ts — that would invert the layering. render.ts
// imports the compiled types + nodeType() from here, one-way.
//
// [LAW:single-enforcer] HUE PIN: hue is accounted ONLY at base leaves — `cells`
// advances one unit per segment, `inline` one unit. A COMPOSITE is hue-NEUTRAL:
// it advances zero units itself and delegates to ctx.renderChild, so it consumes
// exactly the units its expansion's base leaves consume. A stepper expands to ONE
// inline leaf ⇒ ONE hue unit ⇒ visually identical to the old widget that inherited
// its one enclosing segment's hue. The counter lives in the driver; ctx exposes
// only nextHueShift() so there is one mutator.

import { RichText, Style } from "@promptctl/rich-js";
import type { PaletteResolver } from "@promptctl/rich-js";
import type { Template } from "@promptctl/go-template-js";
import type {
  LayoutNode,
  InlineCell,
  Direction,
  SegmentDecl,
} from "../config/dsl-types.js";
import { toString as varToString } from "../var-system/types.js";
import type { VariableStore } from "../var-system/store.js";
import { effectsUrl, VERB_SET_STATE } from "../click/wire.js";
import { splitCellsIntoLines } from "../render/split-lines.js";
import { transposedResolver } from "../themes/index.js";
import {
  fragmentsToCells,
  evaluateWhen,
  applySegmentLayout,
  resolveSegmentColors,
} from "../template-engine/index.js";

// ─── Compiled node shapes ──────────────────────────────────────────────────────

// [LAW:dataflow-not-control-flow] The compiled mirror of a LayoutNode: the same
// recursive shape with every template (`when`, and inline/stepper bg/fg) parsed
// ONCE at registration. renderDsl walks this compiled tree — never the raw config
// — so the parse-once guarantee covers every node.
export interface CompiledCellsNode {
  readonly kind: "cells";
  readonly when?: Template<RichText>;
  readonly segments: readonly string[];
}
export interface CompiledInlineNode {
  readonly kind: "inline";
  readonly when?: Template<RichText>;
  readonly cells: readonly InlineCell[];
  readonly bg?: Template<RichText>;
  readonly fg?: Template<RichText>;
  readonly paletteResolver?: PaletteResolver;
}
export interface CompiledContainerNode {
  readonly kind: "container";
  readonly direction: Direction;
  readonly when?: Template<RichText>;
  readonly children: readonly CompiledNode[];
}
// [LAW:types-are-the-program] A compiled stepper carries its render-derived
// affordances' coordinates: the integer key it WRITES (stateKey), the variable
// that READS it back (stateVar, resolved from the key at compile so the displayed
// value and the written value are one source), the bounds + step, and the color
// it hands to the one inline leaf it expands to. It has NO compiled cells — they
// are derived from the live value at render.
export interface CompiledStepperNode {
  readonly kind: "stepper";
  readonly when?: Template<RichText>;
  readonly stateKey: string;
  readonly stateVar: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  // Unit symbol appended to the displayed value ("" = none); presentation only.
  readonly unit: string;
  readonly bg?: Template<RichText>;
  readonly fg?: Template<RichText>;
  readonly paletteResolver?: PaletteResolver;
}
export type CompiledNode =
  | CompiledCellsNode
  | CompiledInlineNode
  | CompiledContainerNode
  | CompiledStepperNode;

// Pre-parsed templates and pre-resolved palette for one segment, built once at
// registration. A `cells` leaf names segments; render looks each up via
// ctx.lookupSegment.
export interface CompiledSegment {
  readonly when?: Template<RichText>;
  readonly template: Template<RichText>;
  readonly bg?: Template<RichText>;
  readonly fg?: Template<RichText>;
  readonly paletteResolver?: PaletteResolver;
}
export type CompiledSegments = Readonly<Record<string, CompiledSegment>>;

// A rendered node is a LIST OF LINES, each line a list of cells — NOT yet
// serialized. [LAW:types-are-the-program] Cells (not ANSI bytes) are the
// composition substrate: the powerline joiner caps between adjacent cells, so
// serializing a node before composition would freeze its last cell's edge and
// make a cap across a sibling seam unrecoverable. Serialization (the single
// joiner pass) runs exactly once, at the root, after the whole tree composes.
export type RenderedLines = ReadonlyArray<readonly RichText[]>;

// ─── Compile / render contexts (the injected capabilities) ──────────────────────

// [LAW:locality-or-seam] The compile-time context the driver hands each node
// type. `when` is PRE-COMPILED by the driver (walk-owned, uniform across kinds);
// the type only assembles it in. parseField/resolver/stateVarFor/compileChild are
// the leaf capabilities a kind needs without importing the driver.
export interface NodeCompileCtx {
  readonly path: string;
  // The node's own `when`, already parsed by the driver (one parse-when site).
  readonly when?: Template<RichText>;
  // Parse a type-specific template field (inline/stepper bg/fg) with this node's
  // path baked into the error context.
  parseField(src: string, field: string): Template<RichText>;
  // Resolve a palette NAME to its memoized resolver (resolverForThemeName).
  resolver(name: string): PaletteResolver;
  // Resolve a SessionState KEY to the variable that reads it (falls back to the
  // key itself when a variable is named after the key).
  stateVarFor(stateKey: string): string;
  // Compile a child node (the recursion, injected so this module needn't import
  // the driver).
  compileChild(node: LayoutNode, path: string): CompiledNode;
}

// [LAW:single-enforcer] The render-time context. The hue COUNTER lives in the
// driver; ctx exposes only nextHueShift() (advance + return this unit's shift) so
// there is exactly one mutator. `visible` is THIS node's computed visibility
// (the driver ANDs node.when with the parent's). renderChild continues the walk.
export interface NodeRenderCtx {
  readonly scope: object;
  readonly store: VariableStore;
  readonly sessionId: string;
  readonly basePalette: PaletteResolver;
  readonly visible: boolean;
  // Advance the walk-owned hue cursor by one unit and return that unit's shift.
  nextHueShift(): number;
  readonly perSegmentSink?: Map<string, readonly RichText[]>;
  // Resolve a cells-leaf segment name to its decl + compiled form (the driver
  // closes over config.segments + the compiled segments).
  lookupSegment(
    name: string,
  ):
    | { readonly seg: SegmentDecl; readonly compiled: CompiledSegment }
    | undefined;
  // Continue the walk into a child node (parentVisible = this node's visibility).
  renderChild(node: CompiledNode, parentVisible: boolean): RenderedLines;
}

// ─── Composition ───────────────────────────────────────────────────────────────

// [LAW:dataflow-not-control-flow] A container's `direction` is the projection it
// applies to its already-rendered child blocks — DATA selecting a fold, not a
// branch that skips work. `vertical` STACKS (concatenate the children's line-
// lists); `horizontal` ZIPS (row i is every child's row-i cells concatenated, so
// the joiner caps ACROSS the seam — there is no abut). The switch is exhaustive
// over `Direction`; adding `outline` to DIRECTIONS forces a new arm here.
function composeBlocks(
  direction: Direction,
  blocks: readonly RenderedLines[],
): RenderedLines {
  switch (direction) {
    case "vertical":
      return blocks.flatMap((b) => b);
    case "horizontal": {
      const height = blocks.reduce((m, b) => Math.max(m, b.length), 0);
      const rows: RichText[][] = [];
      for (let i = 0; i < height; i++) {
        rows.push(blocks.flatMap((b) => b[i] ?? []));
      }
      return rows;
    }
  }
}

// [LAW:single-enforcer] One inline-cell click → URL mapping: a structured
// (key, value) write becomes exactly one `set-state` effect on the one click
// wire. effectsUrl owns the encoding; this names the single-effect shape an
// inline cell emits. A stepper's ◀/▶ ride this SAME path (their cells are inline
// cells), so there is no second click-URL builder.
function setStateUrl(sessionId: string, key: string, value: string): string {
  return effectsUrl([{ verb: VERB_SET_STATE, args: [sessionId, key, value] }]);
}

// Stepper affordance glyphs (render-derived, not authored).
const STEP_DEC = "◀";
const STEP_INC = "▶";
// [LAW:one-source-of-truth] The canonical integer shape both the render read
// boundary and the range validator accept (`^-?\d+$`). A float/typo/empty value
// is NOT loosely parsed — it starts at the floor — so the displayed current is
// always an in-range integer the wire validator would also accept.
const INT_SHAPE = /^-?\d+$/;

// ─── The node-type contract + registry ──────────────────────────────────────────

type NodeKind = LayoutNode["kind"];

// [LAW:types-are-the-program] One contract per node kind, generic over the kind so
// each entry's compile/render see their OWN narrowed node arm — never the union,
// so no internal re-narrow guard. compile (registration: LayoutNode → compiled,
// parse-once) and render (per-render: compiled → lines) are co-located per kind.
export interface NodeType<K extends NodeKind> {
  compile(
    node: Extract<LayoutNode, { kind: K }>,
    cctx: NodeCompileCtx,
  ): Extract<CompiledNode, { kind: K }>;
  render(
    node: Extract<CompiledNode, { kind: K }>,
    ctx: NodeRenderCtx,
  ): RenderedLines;
}

const containerType: NodeType<"container"> = {
  compile(node, cctx) {
    return {
      kind: "container",
      direction: node.direction,
      when: cctx.when,
      children: node.children.map((child, i) =>
        cctx.compileChild(child, `${cctx.path}.children[${i}]`),
      ),
    };
  },
  render(node, ctx) {
    // [LAW:dataflow-not-control-flow] A container advances NO hue unit itself; its
    // children do, walked in order so positional hue stays stable. Hidden or not,
    // every child is rendered (parentVisible threads the gate) so hidden subtrees
    // still advance the cursor.
    return composeBlocks(
      node.direction,
      node.children.map((child) => ctx.renderChild(child, ctx.visible)),
    );
  },
};

const cellsType: NodeType<"cells"> = {
  compile(node, cctx) {
    return { kind: "cells", when: cctx.when, segments: node.segments };
  },
  render(node, ctx) {
    // [LAW:dataflow-not-control-flow] The leaf accumulates VISUAL lines, not a
    // flat cell run. A segment's first line continues the current row line; each
    // subsequent line (from an authored "\n") opens a new one. Starts as one empty
    // line so an all-hidden visible leaf still yields exactly one (empty) line.
    const rowLines: RichText[][] = [[]];
    for (const segName of node.segments) {
      const found = ctx.lookupSegment(segName);
      // [LAW:no-defensive-null-guards] The loader validates every cells entry
      // against segments and registerDslConfig compiles every declared segment; a
      // miss is a caller bug (renderDsl given a mismatched compiled object).
      if (!found) {
        throw new Error(`Layout entry "${segName}" has no matching segment`);
      }
      const { seg, compiled: segCompiled } = found;

      const hueShift = ctx.nextHueShift();
      if (!ctx.visible) continue;
      if (!evaluateWhen(segCompiled.when, ctx.scope)) continue;

      // [LAW:dataflow-not-control-flow] The per-segment variability is WHICH
      // palette — the base resolver (per-segment override or basePalette)
      // transposed by hueShift. bg and fg then resolve from this one palette.
      const resolver = transposedResolver(
        segCompiled.paletteResolver ?? ctx.basePalette,
        hueShift,
      );
      const baseStyle = resolveSegmentColors(
        resolver,
        segCompiled.bg,
        segCompiled.fg,
        ctx.scope,
      );

      const fragments = segCompiled.template.evaluate(ctx.scope);
      const segCells = fragmentsToCells(fragments, baseStyle);

      // [LAW:single-enforcer] Partition the segment's authored "\n" into visual
      // lines BEFORE per-segment layout — width/justify/truncate then measure each
      // line cleanly. A newline-free segment is the degenerate one-line case.
      const laidLines = splitCellsIntoLines(segCells).map((line) =>
        applySegmentLayout(line, {
          width: seg.width ?? "auto",
          justify: seg.justify ?? "left",
          truncate: seg.truncate ?? "right",
          baseStyle,
        }),
      );

      laidLines.forEach((laid, i) => {
        if (i > 0) rowLines.push([]);
        rowLines[rowLines.length - 1]!.push(...laid);
      });

      if (ctx.perSegmentSink !== undefined) {
        ctx.perSegmentSink.set(segName, laidLines.flat());
      }
    }

    if (!ctx.visible) return [];
    return rowLines;
  },
};

const inlineType: NodeType<"inline"> = {
  compile(node, cctx) {
    return {
      kind: "inline",
      when: cctx.when,
      cells: node.cells,
      // [LAW:one-source-of-truth] bg/fg parse through the SAME engine and resolve
      // via the SAME resolveSegmentColors as a segment's, so an inline leaf's color
      // follows one color path — never a second that could drift.
      bg: node.bg !== undefined ? cctx.parseField(node.bg, "bg") : undefined,
      fg: node.fg !== undefined ? cctx.parseField(node.fg, "fg") : undefined,
      paletteResolver:
        node.palette !== undefined ? cctx.resolver(node.palette) : undefined,
    };
  },
  render(node, ctx) {
    // [LAW:single-enforcer] An inline leaf is ONE hue unit (like a segment): it
    // consumes exactly one shift so its color is positionally stable and siblings
    // after it keep their colors regardless of its visibility.
    const hueShift = ctx.nextHueShift();
    if (!ctx.visible) return [];

    const resolver = transposedResolver(
      node.paletteResolver ?? ctx.basePalette,
      hueShift,
    );
    const baseStyle = resolveSegmentColors(
      resolver,
      node.bg,
      node.fg,
      ctx.scope,
    );

    // [LAW:dataflow-not-control-flow] Each cell becomes one fragment; a cell's
    // `onClick` (a value, not a branch) decides whether that fragment carries an
    // OSC-8 set-state link. fragmentsToCells then splits at link boundaries so each
    // clickable cell is independently addressable. Inter-cell single spaces match
    // the inline spacing the bar already renders.
    const fragments = node.cells.flatMap((cell, i) => {
      const frag =
        cell.onClick !== undefined
          ? new RichText(cell.text, {
              style: new Style({
                link: setStateUrl(
                  ctx.sessionId,
                  cell.onClick.set,
                  cell.onClick.to,
                ),
              }),
            })
          : new RichText(cell.text);
      return i > 0 ? [new RichText(" "), frag] : [frag];
    });
    // [LAW:single-enforcer] An inline leaf is ONE unit ⇒ ONE strip item. It runs
    // through the SAME applySegmentLayout that collapses a segment line, at "auto"
    // width (collapse, no resize): the joiner caps only at the leaf's edges, never
    // between its clickable regions (each onClick survives as its own OSC-8 span),
    // and a leaf that rendered nothing yields zero cells — no empty item to draw a
    // spurious cap. One enforcer of "a unit's line is 0-or-1 strip item".
    return [
      applySegmentLayout(fragmentsToCells(fragments, baseStyle), {
        width: "auto",
        justify: "left",
        truncate: "right",
        baseStyle,
      }),
    ];
  },
};

const stepperType: NodeType<"stepper"> = {
  compile(node, cctx) {
    return {
      kind: "stepper",
      when: cctx.when,
      stateKey: node.state,
      stateVar: cctx.stateVarFor(node.state),
      min: node.min,
      max: node.max,
      step: node.step,
      unit: node.unit ?? "",
      bg: node.bg !== undefined ? cctx.parseField(node.bg, "bg") : undefined,
      fg: node.fg !== undefined ? cctx.parseField(node.fg, "fg") : undefined,
      paletteResolver:
        node.palette !== undefined ? cctx.resolver(node.palette) : undefined,
    };
  },
  render(node, ctx) {
    // [LAW:single-enforcer] The range validator clamps every WRITTEN value into
    // bounds, but a state var's `default` is config (not a write) so it bypasses
    // the gate. Mirror the validator's canonical-integer shape at this read
    // boundary: only an integer-shaped string is clamped into [min,max]; anything
    // else (empty/float/typo) starts at the floor — so the displayed current is
    // always an in-range integer the wire validator would also accept.
    const rawStr = ctx.store.has(node.stateVar)
      ? varToString(ctx.store.read(node.stateVar))
      : "";
    const current = INT_SHAPE.test(rawStr)
      ? Math.max(node.min, Math.min(node.max, parseInt(rawStr, 10)))
      : node.min;
    // [LAW:dataflow-not-control-flow] The stepper owns NAVIGATION — stepping past a
    // bound WRAPS to the other end (one behavior, no clamp-vs-wrap mode). The
    // wrapped writes always land inside bounds, so the range gate passes them.
    const wrapped = (v: number): number =>
      v > node.max ? node.min : v < node.min ? node.max : v;
    const dec = wrapped(current - node.step);
    const inc = wrapped(current + node.step);

    // [LAW:single-enforcer] HUE PIN realized: expand to ONE inline leaf and hand
    // off to the walk. That leaf consumes the single hue unit and owns the one
    // color path + one click-URL path — the stepper builds neither itself. The
    // current display is a plain (non-link) cell; only ◀/▶ are clickable.
    const inlineNode: CompiledInlineNode = {
      kind: "inline",
      when: undefined,
      cells: [
        { text: STEP_DEC, onClick: { set: node.stateKey, to: String(dec) } },
        // [LAW:single-enforcer] The unit rides the plain current cell only — the
        // ◀/▶ links still carry bare integers, so the wire value and the display
        // string stay separate (the range gate never sees "14°").
        { text: `${current}${node.unit}` },
        { text: STEP_INC, onClick: { set: node.stateKey, to: String(inc) } },
      ],
      bg: node.bg,
      fg: node.fg,
      paletteResolver: node.paletteResolver,
    };
    return ctx.renderChild(inlineNode, ctx.visible);
  },
};

// [LAW:single-enforcer] THE registry. `satisfies` forces an entry for every
// LayoutNode kind — adding a kind to the union breaks compilation here until its
// behavior is registered, so "register a type" is one mechanically-enforced act.
const REGISTRY = {
  container: containerType,
  cells: cellsType,
  inline: inlineType,
  stepper: stepperType,
} satisfies { [K in NodeKind]: NodeType<K> };

// [LAW:types-are-the-program] The one dispatch primitive. Indexing by a node's OWN
// kind returns the entry built FOR that kind, so the pairing is sound by
// construction; the cast only widens the static K to the union (TS cannot prove
// the index/arm link across a heterogeneous registry). Every consumer calls
// nodeType(node.kind).method(node) — no consumer re-switches on kind.
export function nodeType(kind: NodeKind): NodeType<NodeKind> {
  return REGISTRY[kind] as unknown as NodeType<NodeKind>;
}
