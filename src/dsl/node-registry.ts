// [LAW:single-enforcer] THE node-type registry: each layout node kind's compile +
// render behind one typed lookup. [LAW:one-type-per-behavior] Two kinds only —
// `container` arranges, `segment` renders. [LAW:one-way-deps] Never import render.ts.

import { RichText } from "@promptctl/rich-js";
import type { Palette, Style } from "@promptctl/rich-js";
import type { Template } from "@promptctl/go-template-js";
import type {
  LayoutNode,
  Direction,
  SegmentDecl,
} from "../config/dsl-types.js";
import { disclosureGate } from "../config/disclosure.js";
import { splitCellsIntoLines } from "../render/split-lines.js";
import {
  placedBy,
  type AddressStep,
  type Disclosure,
  type Distribution,
  type Region,
} from "../themes/decor.js";
import {
  fragmentsToCells,
  evaluateWhen,
  applySegmentLayout,
} from "../template-engine/index.js";

// [LAW:dataflow-not-control-flow] The compiled mirror of a LayoutNode, every `when` parsed ONCE.
export interface CompiledSegmentNode {
  readonly kind: "segment";
  readonly when?: Template<RichText>;
  readonly name: string;
  // [LAW:one-source-of-truth] Openness parsed once from the ref the trigger's cycle writes.
  readonly opens?: CompiledOpens;
}
export interface CompiledOpens {
  readonly open: Template<RichText>;
  readonly body: CompiledContainerNode;
}
export interface CompiledContainerNode {
  readonly kind: "container";
  readonly direction: Direction;
  readonly when?: Template<RichText>;
  readonly children: readonly CompiledNode[];
  // [LAW:parse-dont-validate] The authored name resolved ONCE to a placement function.
  readonly distribution: Distribution;
}
export type CompiledNode = CompiledSegmentNode | CompiledContainerNode;

// [LAW:types-are-the-program] A ContainerNode compiles to CompiledContainerNode, not the union.
export type Compiled<N extends LayoutNode> = Extract<
  CompiledNode,
  { kind: N["kind"] }
>;

export interface CompiledSegment {
  readonly when?: Template<RichText>;
  readonly template: Template<RichText>;
  readonly bg?: Template<RichText>;
  readonly fg?: Template<RichText>;
  readonly palette?: Palette;
}
export type CompiledSegments = Readonly<Record<string, CompiledSegment>>;

// [LAW:types-are-the-program] Cells, not ANSI bytes: serializing before composition
// would freeze a cell's edge against the joiner. One joiner pass runs, at the root.
export type RenderedLines = ReadonlyArray<readonly RichText[]>;

// [LAW:locality-or-seam] compileChild is injected so this module needn't import the driver.
export interface NodeCompileCtx {
  readonly path: string;
  readonly when?: Template<RichText>;
  parse(src: string, field: string): Template<RichText>;
  compileChild<N extends LayoutNode>(node: N, path: string): Compiled<N>;
}

// [LAW:single-enforcer] `visible` is THIS node's visibility — the driver ANDs it with the parent's.
export interface NodeRenderCtx {
  readonly scope: object;
  // [LAW:one-source-of-truth] Transposed ONCE by the driver; every unpinned segment colours from it.
  readonly palette: Palette;
  readonly visible: boolean;
  // [LAW:one-source-of-truth] One value per render, never re-defaulted per node.
  readonly padding: number;
  // [LAW:effects-at-boundaries] A pure fact about position, unchanged by any node being hidden.
  readonly region: Region;
  readonly perSegmentSink?: Map<string, readonly RichText[]>;
  // [LAW:no-silent-failure] Reported so a headless caller gets a text verdict. Trusted non-throwing.
  readonly onSegmentError?: (segName: string, message: string) => void;
  // [LAW:locality-or-seam] The segment seam, so this module never imports the menu or
  // colour features. bg/fg resolve at entry — a body asking for its own bg needs it first.
  enterSegment(
    segName: string,
    palette: Palette,
    region: Region,
    bgTemplate: Template<RichText> | undefined,
    fgTemplate: Template<RichText> | undefined,
  ): SegmentStyles;
  exitSegment(fragments: readonly RichText[]): readonly RichText[];
  lookupSegment(
    name: string,
  ):
    | { readonly seg: SegmentDecl; readonly compiled: CompiledSegment }
    | undefined;
  renderChild(
    node: CompiledNode,
    parentVisible: boolean,
    step: AddressStep,
  ): RenderedLines;
  renderBody(
    body: CompiledContainerNode,
    open: boolean,
    band: Disclosure,
  ): RenderedLines;
}

// [LAW:types-are-the-program] Every Style a segment can wear, resolved at entry as one
// value the walk selects between; `disclosure` is the band `trigger`/`band` came from.
export interface SegmentStyles {
  readonly closed: Style;
  readonly trigger: Style;
  readonly band: Style;
  readonly disclosure: Disclosure;
}

// [LAW:dataflow-not-control-flow] `direction` is DATA selecting a fold, and the switch
// is exhaustive over Direction. [LAW:decomposition] `horizontal` zips ONLY row 0 so the
// joiner caps across the seam; drops stack full-width. Column alignment is UNSUPPORTED.
function composeBlocks(
  direction: Direction,
  blocks: readonly RenderedLines[],
): RenderedLines {
  switch (direction) {
    case "vertical":
      return blocks.flatMap((b) => b);
    case "horizontal": {
      // [LAW:dataflow-not-control-flow] height 0 ⇒ NO line; a stray [[]] would be a blank row.
      const height = blocks.reduce((m, b) => Math.max(m, b.length), 0);
      if (height === 0) return [];
      const row0 = blocks.flatMap((b) => b[0] ?? []);
      const drops = blocks.flatMap((b) => b.slice(1));
      return [row0, ...drops];
    }
  }
}

type NodeKind = LayoutNode["kind"];

// [LAW:types-are-the-program] Generic over the kind so each entry sees its OWN narrowed arm.
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
      distribution: placedBy(node.distribution),
      children: node.children.map((child, i) =>
        cctx.compileChild(child, `${cctx.path}.children[${i}]`),
      ),
    };
  },
  render(node, ctx) {
    // [LAW:dataflow-not-control-flow] Every child is walked, hidden or not: visibility is a value.
    return composeBlocks(
      node.direction,
      node.children.map((child, index) =>
        ctx.renderChild(child, ctx.visible, {
          index,
          count: node.children.length,
          distribution: node.distribution,
        }),
      ),
    );
  },
};

const segmentType: NodeType<"segment"> = {
  compile(node, cctx) {
    return {
      kind: "segment",
      when: cctx.when,
      name: node.name,
      // [LAW:one-source-of-truth] Openness is the ref, through the one `disclosureGate`.
      ...(node.opens !== undefined && {
        opens: {
          open: cctx.parse(disclosureGate(node.opens.ref), "opens"),
          body: cctx.compileChild(node.opens.body, `${cctx.path}.opens.body`),
        },
      }),
    };
  },
  render(node, ctx) {
    const found = ctx.lookupSegment(node.name);
    // [LAW:no-defensive-null-guards] The loader validates every segment ref; a miss is a caller bug.
    if (!found) {
      throw new Error(`Layout segment "${node.name}" has no matching segment`);
    }
    const { seg, compiled: segCompiled } = found;
    if (!ctx.visible) return [];

    // [LAW:no-silent-failure] A broken segment shows an error cell; the rest still render.
    try {
      if (!evaluateWhen(segCompiled.when, ctx.scope)) return [];

      // [LAW:dataflow-not-control-flow] A pin ignores the look as it ignores the session theme.
      const palette = segCompiled.palette ?? ctx.palette;

      // [LAW:one-source-of-truth] ONE palette per segment — why entry precedes body evaluation.
      const styles = ctx.enterSegment(
        node.name,
        palette,
        ctx.region,
        segCompiled.bg,
        segCompiled.fg,
      );
      const fragments = segCompiled.template.evaluate(ctx.scope);
      // [LAW:decomposition] Open menu bodies ride as out-of-band metadata on the fragments.
      const drops = ctx.exitSegment(fragments);
      const bodyOpen =
        node.opens !== undefined && evaluateWhen(node.opens.open, ctx.scope);
      const bodyLines =
        node.opens === undefined
          ? []
          : ctx.renderBody(node.opens.body, bodyOpen, styles.disclosure);
      // [LAW:dataflow-not-control-flow] The drop list IS the open-menu signal.
      const open = drops.length > 0 || bodyOpen;
      const baseStyle = open ? styles.trigger : styles.closed;
      const layout = {
        width: seg.width ?? "auto",
        justify: seg.justify ?? "left",
        truncate: seg.truncate ?? "right",
        baseStyle,
        // [LAW:dataflow-not-control-flow] One value for inline rows AND dropped bands.
        padding: ctx.padding,
      } as const;

      // [LAW:single-enforcer] Each laid line is ONE strip item, so the joiner caps only at its edges.
      const inlineLines = splitCellsIntoLines(
        fragmentsToCells(fragments, baseStyle),
      ).map((line) => applySegmentLayout(line, layout));
      const dropLines = drops.map((body) =>
        applySegmentLayout(fragmentsToCells([body], styles.band), {
          ...layout,
          baseStyle: styles.band,
        }),
      );
      const laidLines = [...inlineLines, ...dropLines];

      if (ctx.perSegmentSink !== undefined) {
        ctx.perSegmentSink.set(node.name, laidLines.flat());
      }
      return [...laidLines, ...bodyLines];
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      ctx.onSegmentError?.(node.name, message);
      return [[new RichText(`⚠ ${node.name}: ${message}`)]];
    }
  },
};

// [LAW:single-enforcer] THE registry: `satisfies` forces an entry for every node kind.
const REGISTRY = {
  container: containerType,
  segment: segmentType,
} satisfies { [K in NodeKind]: NodeType<K> };

// [LAW:types-are-the-program] Indexing by a node's OWN kind returns the entry built for it.
export function nodeType(kind: NodeKind): NodeType<NodeKind> {
  return REGISTRY[kind] as unknown as NodeType<NodeKind>;
}
