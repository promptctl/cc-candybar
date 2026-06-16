// [LAW:single-enforcer] THE node-type registry: the one place each layout node
// kind's render-time behavior (compile + render) is defined, dispatched through a
// single typed lookup. The walk is ONE uniform dispatch:
// nodeType(node.kind).render(node, ctx).
//
// [LAW:one-type-per-behavior] The layout is exactly two kinds — `container`
// (arranges children) and `segment` (THE unit of rendering: one ref into the
// named segments map, rendered to ONE strip item). Interaction, state-driven
// display, and multi-region clickability all live in a segment's TEMPLATE, not
// in extra node kinds — so there is no inline/stepper/picker node arm to add.
// A horizontal run of segments is spelled `{ h: ["seg1", "seg2"] }` in the
// A-grammar (the `cells` form and `layout` rows were deleted in 2de.19).
//
// [LAW:one-way-deps] This module sits BELOW render.ts (the driver): it imports
// the leaf render/template helpers directly and receives the two recursive
// capabilities (compileChild, renderChild) + the hue counter as DATA from the
// driver. It must NOT import render.ts — that would invert the layering. render.ts
// imports the compiled types + nodeType() from here, one-way.
//
// Hue is per-segment DECORATIVE only: each `segment` advances the cursor by one
// unit (a container advances none), so colors stay positionally stable. It
// carries NO structural meaning — unit cohesion is structural (one segment = one
// strip item), not a function of matching backgrounds.

import { RichText } from "@promptctl/rich-js";
import type { PaletteResolver, Style } from "@promptctl/rich-js";
import type { Template } from "@promptctl/go-template-js";
import type {
  LayoutNode,
  Direction,
  SegmentDecl,
} from "../config/dsl-types.js";
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
// recursive shape with every `when` parsed ONCE at registration. renderDsl walks
// this compiled tree — never the raw config — so the parse-once guarantee covers
// every node.
export interface CompiledSegmentNode {
  readonly kind: "segment";
  readonly when?: Template<RichText>;
  readonly name: string;
}
export interface CompiledContainerNode {
  readonly kind: "container";
  readonly direction: Direction;
  readonly when?: Template<RichText>;
  readonly children: readonly CompiledNode[];
}
export type CompiledNode = CompiledSegmentNode | CompiledContainerNode;

// Pre-parsed templates and pre-resolved palette for one segment, built once at
// registration. A `segment` node names one; render looks it up via
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
// the type only assembles it in. compileChild is the recursion, injected so this
// module needn't import the driver.
export interface NodeCompileCtx {
  readonly path: string;
  // The node's own `when`, already parsed by the driver (one parse-when site).
  readonly when?: Template<RichText>;
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
  readonly basePalette: PaletteResolver;
  readonly visible: boolean;
  // Advance the walk-owned hue cursor by one unit and return that unit's shift.
  nextHueShift(): number;
  readonly perSegmentSink?: Map<string, readonly RichText[]>;
  // [LAW:locality-or-seam] The menu seam, injected as capabilities so this module
  // never imports the menu feature. `beginSegment` runs BEFORE a segment template
  // evaluates: it publishes the segment name so a `{{ menu }}` can derive its
  // identity. `collectDrops` runs AFTER eval: it reads the open menu bodies the
  // menus carried as metadata on the evaluated fragments (template order) for the
  // boundary to stack below the row, and clears the published placement. The
  // driver owns the menu runtime; this module only hands it the fragments.
  beginSegment(segName: string): void;
  collectDrops(fragments: readonly RichText[]): readonly RichText[];
  // [LAW:locality-or-seam] The focus transform, injected as a capability (rich-js
  // owns the color math — see render.ts). Applied to the segment's baseStyle when
  // it has an open menu (it contributed drops), so the whole focused segment —
  // inline trigger + dropped body band — reads as highlighted.
  focusTint(style: Style): Style;
  // Resolve a segment name to its decl + compiled form (the driver closes over
  // config.segments + the compiled segments).
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
// lists). The switch is exhaustive over `Direction`; adding `outline` to
// DIRECTIONS forces a new arm here.
//
// [LAW:decomposition] `horizontal` composes ONLY row 0 across the seam — row 0 is
// every child's FIRST line zipped (the inline powerline run, so the joiner caps
// across the seam, no abut). Every line BELOW row 0 is a child's DROP (a menu body
// dropping below its trigger, a genuinely multi-line segment): drops STACK full-
// width in child order, never zipped. Multi-line side-by-side column alignment is
// explicitly UNSUPPORTED — aligning two children's row-i cells would require
// background-as-structure, and bg is never structural. For an all-single-line row
// (no child has a drop) this is byte-identical to a plain per-row zip.
function composeBlocks(
  direction: Direction,
  blocks: readonly RenderedLines[],
): RenderedLines {
  switch (direction) {
    case "vertical":
      return blocks.flatMap((b) => b);
    case "horizontal": {
      // [LAW:dataflow-not-control-flow] height 0 (every child hidden/empty) ⇒ the
      // container contributes NO line — not one empty row. This is the value-driven
      // identity of the fold, preserved from the per-row zip it replaces; a stray
      // [[]] here would render as a spurious blank line.
      const height = blocks.reduce((m, b) => Math.max(m, b.length), 0);
      if (height === 0) return [];
      const row0 = blocks.flatMap((b) => b[0] ?? []);
      const drops = blocks.flatMap((b) => b.slice(1));
      return [row0, ...drops];
    }
  }
}

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

const segmentType: NodeType<"segment"> = {
  compile(node, cctx) {
    return {
      kind: "segment",
      when: cctx.when,
      name: node.name,
    };
  },
  render(node, ctx) {
    const found = ctx.lookupSegment(node.name);
    // [LAW:no-defensive-null-guards] The loader validates every segment ref
    // against the segments map and registerDslConfig compiles every declared
    // segment; a miss is a caller bug (renderDsl given a mismatched compiled
    // object).
    if (!found) {
      throw new Error(`Layout segment "${node.name}" has no matching segment`);
    }
    const { seg, compiled: segCompiled } = found;

    // [LAW:single-enforcer] Advance the hue cursor BEFORE the visibility gate so a
    // hidden segment still consumes its unit — siblings after it keep their
    // positionally-stable colors regardless of which segments are hidden.
    const hueShift = ctx.nextHueShift();
    if (!ctx.visible) return [];

    // [LAW:no-silent-failure] Wrap the whole render body in a try/catch so a
    // partial-load consequence (e.g. a variable that failed to declare, leaving a
    // MissingFieldError when the template or when-predicate accesses it) surfaces
    // as a visible error cell rather than crashing the whole bar. The remaining
    // segments render normally. This is the render-time complement to the per-
    // variable catch in registerDslConfig — together they implement option-2
    // partial rendering: the new config stays active, working segments render, and
    // broken segments show an error cell.
    try {
      if (!evaluateWhen(segCompiled.when, ctx.scope)) return [];

      // [LAW:single-enforcer] Publish the segment name + clear the drop sink
      // BEFORE evaluating the template — a `{{ menu }}` inside reads the name to
      // derive its identity and contributes its open body to the sink.
      ctx.beginSegment(node.name);
      const fragments = segCompiled.template.evaluate(ctx.scope);
      // [LAW:decomposition] The open menu bodies, carried as out-of-band metadata
      // on the evaluated fragments — invisible to the inline render, so a menu can
      // sit anywhere in the template and content after it stays inline. Each
      // becomes one full-width line stacked below the segment's row.
      const drops = ctx.collectDrops(fragments);

      // [LAW:dataflow-not-control-flow] The per-segment variability is WHICH
      // palette — the base resolver (per-segment override or basePalette)
      // transposed by hueShift. bg and fg then resolve from this one palette.
      const resolver = transposedResolver(
        segCompiled.paletteResolver ?? ctx.basePalette,
        hueShift,
      );
      const resolvedStyle = resolveSegmentColors(
        resolver,
        segCompiled.bg,
        segCompiled.fg,
        ctx.scope,
      );
      // [LAW:dataflow-not-control-flow] Focus is the PRESENCE of a drop: a segment
      // with an open menu (it contributed a body) lightens, so the whole focused
      // segment — inline trigger + dropped band — reads as highlighted. No state
      // re-read; the drop list IS the open-menu signal.
      const baseStyle =
        drops.length > 0 ? ctx.focusTint(resolvedStyle) : resolvedStyle;
      const layout = {
        width: seg.width ?? "auto",
        justify: seg.justify ?? "left",
        truncate: seg.truncate ?? "right",
        baseStyle,
      } as const;

      // [LAW:single-enforcer] Partition the segment's authored "\n" into visual
      // lines BEFORE per-segment layout — width/justify/truncate then measure each
      // line cleanly. A newline-free segment is the degenerate one-line case. Each
      // laid line is ONE strip item: applySegmentLayout collapses a line's cells to
      // 0-or-1 item (OSC-8 links survive as interior spans), so the joiner caps only
      // at the segment's edges, never inside it.
      const inlineLines = splitCellsIntoLines(
        fragmentsToCells(fragments, baseStyle),
      ).map((line) => applySegmentLayout(line, layout));
      // Each open menu body is one full-width dropped line, in the segment's
      // (focus-tinted) bg, stacked after the inline row(s). composeBlocks then
      // drops every line below row 0 below the enclosing horizontal row.
      const dropLines = drops.map((body) =>
        applySegmentLayout(fragmentsToCells([body], baseStyle), layout),
      );
      const laidLines = [...inlineLines, ...dropLines];

      if (ctx.perSegmentSink !== undefined) {
        ctx.perSegmentSink.set(node.name, laidLines.flat());
      }
      return laidLines;
    } catch (err) {
      return [
        [
          new RichText(
            `⚠ ${node.name}: ${(err as Error).message ?? String(err)}`,
          ),
        ],
      ];
    }
  },
};

// [LAW:single-enforcer] THE registry. `satisfies` forces an entry for every
// LayoutNode kind — adding a kind to the union breaks compilation here until its
// behavior is registered, so "register a type" is one mechanically-enforced act.
const REGISTRY = {
  container: containerType,
  segment: segmentType,
} satisfies { [K in NodeKind]: NodeType<K> };

// [LAW:types-are-the-program] The one dispatch primitive. Indexing by a node's OWN
// kind returns the entry built FOR that kind, so the pairing is sound by
// construction; the cast only widens the static K to the union (TS cannot prove
// the index/arm link across a heterogeneous registry). Every consumer calls
// nodeType(node.kind).method(node) — no consumer re-switches on kind.
export function nodeType(kind: NodeKind): NodeType<NodeKind> {
  return REGISTRY[kind] as unknown as NodeType<NodeKind>;
}
