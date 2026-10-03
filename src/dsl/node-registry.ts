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
// capabilities (compileChild, renderChild) from the driver. It must NOT import
// render.ts — that would invert the layering. render.ts imports the compiled
// types + nodeType() from here, one-way.
//
// Colour is DECORATIVE only: a segment's tint derives from its address (where
// it sits in the tree) and carries NO structural meaning — unit cohesion is
// structural (one segment = one strip item), not a function of matching
// backgrounds.

import { RichText } from "@promptctl/rich-js";
import type { Palette, Style } from "@promptctl/rich-js";
import type { Template } from "@promptctl/go-template-js";
import type {
  LayoutNode,
  Direction,
  Placement,
  SegmentDecl,
  SegmentNode,
  SettingValue,
} from "../config/dsl-types.js";
import {
  AXIS_OF,
  bodyPath,
  childPath,
  placementId,
} from "../config/dsl-types.js";
import { placementPalette } from "../themes/palette-resolvers.js";
import { disclosureGate } from "../config/disclosure.js";
import { splitCellsIntoLines } from "../render/split-lines.js";
import {
  placedBy,
  type Address,
  type AddressStep,
  type Disclosure,
  type Distribution,
  type Region,
} from "../themes/decor.js";
import {
  fragmentsToCells,
  evaluateWhen,
  applySegmentLayout,
  placementScope,
} from "../template-engine/index.js";
import { cellParts, type LaidCell } from "../template-engine/layout.js";

// ─── Compiled node shapes ──────────────────────────────────────────────────────

// [LAW:dataflow-not-control-flow] The compiled mirror of a LayoutNode: the same
// recursive shape with every `when` parsed ONCE at registration. renderDsl walks
// this compiled tree — never the raw config — so the parse-once guarantee covers
// every node.
export interface CompiledSegmentNode {
  readonly kind: "segment";
  readonly when?: Template<RichText>;
  readonly name: string;
  // [LAW:parse-dont-validate] The placement's identity, resolved once
  // (`placementId`), and its settings resolved against its segment's
  // declaration — every declared setting present, the placement's value else
  // the default — so the render reads a finished object, never a fallback.
  readonly id: string;
  readonly settings: PlacementSettings;
  // The disclosure body this segment opens (SegmentNode.opens), with its
  // openness parsed ONCE from the ref — `disclosureGate(ref)` — so the body's
  // gate is derived from the same pair the trigger's cycle writes.
  readonly opens?: CompiledOpens;
  readonly lead?: Template<RichText>;
  readonly trail?: Template<RichText>;
}
export interface CompiledOpens {
  readonly open: Template<RichText>;
  readonly body: CompiledContainerNode;
  // The state key the body's ✕ writes closed — the ref's own, carried so the
  // row affordance and the trigger's cycle cannot name different keys.
  readonly key: string;
  readonly placement: Placement;
}
export interface CompiledContainerNode {
  readonly kind: "container";
  readonly direction: Direction;
  readonly when?: Template<RichText>;
  readonly children: readonly CompiledNode[];
  // [LAW:parse-dont-validate] The authored NAME (or its absence) resolved ONCE
  // to the function this container places its children by — every child's
  // address step carries it, so the walk never re-reads the config.
  readonly distribution: Distribution;
}
export type CompiledNode = CompiledSegmentNode | CompiledContainerNode;

// [LAW:types-are-the-program] The compiled arm of a raw node kind: a
// ContainerNode compiles to a CompiledContainerNode, never to the union, so a
// disclosure body — a container by type — stays a container once compiled.
export type Compiled<N extends LayoutNode> = Extract<
  CompiledNode,
  { kind: N["kind"] }
>;

// Pre-parsed templates for one segment, built once at registration. A `segment` node names one; render looks it up via
// ctx.lookupSegment.
export interface CompiledSegment {
  readonly when?: Template<RichText>;
  readonly template: Template<RichText>;
  readonly bg?: Template<RichText>;
  readonly fg?: Template<RichText>;
}
export type CompiledSegments = Readonly<Record<string, CompiledSegment>>;

// A rendered node is a LIST OF LINES, each line a list of cells — NOT yet
// serialized. [LAW:types-are-the-program] Cells (not ANSI bytes) are the
// composition substrate: the powerline joiner caps between adjacent cells, so
// serializing a node before composition would freeze its last cell's edge and
// make a cap across a sibling seam unrecoverable. Serialization (the single
// joiner pass) runs exactly once, at the root, after the whole tree composes.
//
// [LAW:types-are-the-program] A line also carries which band it is a row OF,
// relative to the node that rendered it: `own` — a row of the band the node
// sits on, still to be led by that band's ✕ where the band is rooted; `deeper`
// — a row of a band hung under the node (a dropped `{{ menu }}` body, an open
// disclosure body), already led by its own ✕. The trigger that opened a body
// leads its `own` lines and returns them as `deeper` (brandon-disclosure-43z),
// so a row is led exactly once, by the innermost band it sits on — a fact the
// line carries, not one a direction or the walk decides.
//
// And it carries where it goes: `flow` — where the composition puts it; `above`
// — a row of an `above` body, lifted over every container up to the root, so
// the bar's own rows render as they would with the body closed.
export interface Line<C> {
  readonly cells: readonly C[];
  readonly band: "own" | "deeper";
  readonly place: "flow" | "above";
}
export type RenderedLine = Line<LaidCell>;

export type RenderedLines = readonly RenderedLine[];

// ─── Compile / render contexts (the injected capabilities) ──────────────────────

// [LAW:locality-or-seam] The compile-time context the driver hands each node
// type. `when` is PRE-COMPILED by the driver (walk-owned, uniform across kinds);
// the type only assembles it in. compileChild is the recursion, injected so this
// module needn't import the driver.
export interface NodeCompileCtx {
  readonly path: string;
  // The node's own `when`, already parsed by the driver (one parse-when site).
  readonly when?: Template<RichText>;
  // Parse one more template field of THIS node through the driver's one
  // parse site, so its error names `path.field` like a `when` does.
  parse(src: string, field: string): Template<RichText>;
  // Compile a child node (the recursion, injected so this module needn't import
  // the driver). Generic so a container child compiles to a container.
  compileChild<N extends LayoutNode>(node: N, path: string): Compiled<N>;
  // The resolved settings of a segment placement: the driver holds the
  // declarations they resolve against.
  placementSettings(node: SegmentNode): PlacementSettings;
}

// What a placement's templates read as `.settings`: a frozen, null-prototype
// record, so no inherited name resolves as a setting. `theme` is always there
// (settingsOf) and always a theme's name or `bar` — the domain it resolves
// against holds nothing else.
export type PlacementSettings = Readonly<Record<string, SettingValue>> & {
  readonly theme: string;
};

// [LAW:single-enforcer] The render-time context. `visible` is THIS node's
// computed visibility (the driver ANDs node.when with the parent's).
// renderChild continues the walk.
export interface NodeRenderCtx {
  // The render's scope. A placement's own templates evaluate in it with
  // `.settings` bound (`placementScope`); everything else reads it as is.
  readonly scope: object;
  // [LAW:one-source-of-truth] The render's palette: the base theme (session
  // choice over config default) under the render's style, transposed ONCE by
  // the driver — every unpinned segment colours from this one object.
  readonly palette: Palette;
  readonly visible: boolean;
  // [LAW:one-source-of-truth] The render-wide intra-cell padding (resolved
  // globals.padding), threaded by the driver from BuildLineOptions into every
  // segment's layout — one value per render, never re-defaulted per node.
  readonly padding: number;
  // [LAW:effects-at-boundaries] THIS node's region: the bar with the
  // (index, count) steps from the root, or the band a disclosure body hangs
  // on with the steps since that body — extended by one step per container
  // level by the driver, re-rooted onto a band by `renderBody`. A pure fact
  // about position — unchanged by any node being hidden — that the segment
  // hands to `evaluateSegment` so its colours derive from where it sits, with no
  // walk state read.
  readonly region: Region;
  readonly perSegmentSink?: Map<string, readonly RichText[]>;
  // [LAW:no-silent-failure] Optional observer for the per-segment render catch
  // below: a caught evaluation error renders as a visible ⚠ error cell (partial
  // rendering — the daemon's channel), AND is reported here so a headless caller
  // (`cc-candybar check`, a blind authoring agent's eyes) can turn it into a
  // text verdict instead of blessing a bar it cannot see. Trusted non-throwing
  // (the registry-dispose contract) — see RenderObservers.onSegmentError.
  readonly onSegmentError?: (placementId: string, message: string) => void;
  // [LAW:locality-or-seam] The segment seam, injected as a capability so this
  // module never imports the menu or color features — it only hands over a
  // segment's templates and gets back what evaluating them produced.
  //
  // Before any of the segment's templates evaluate, the seam publishes what
  // they may ask about themselves — the name a `{{ menu }}` derives its
  // identity from, the palette `{{ color }}` resolves against, the background
  // `{{ bgOf }}` returns — and resolves the segment's `bg:`/`fg:` into its
  // base Style along the way; a body asking for its own background can only be
  // answered once the background exists. Then the body evaluates, and the seam
  // returns its fragments beside the bodies its open `{{ menu }}`s dropped
  // (template order), for the boundary to stack below the row.
  //
  // [LAW:no-ambient-temporal-coupling] Publishing and tearing down are ONE
  // call, so a template that throws cannot leave the record published for
  // whatever evaluates next outside any segment.
  evaluateSegment(
    placement: CompiledSegmentNode,
    scope: object,
    palette: Palette,
    region: Region,
    templates: {
      readonly bg: Template<RichText> | undefined;
      readonly fg: Template<RichText> | undefined;
      readonly body: Template<RichText>;
      readonly lead: Template<RichText> | undefined;
      readonly trail: Template<RichText> | undefined;
    },
    // Whether the disclosure body this segment hangs is open: with the menu
    // bodies its own template drops, it decides the ground the segment wears.
    bodyOpen: boolean,
  ): EvaluatedSegment;
  // Resolve a segment name to its decl + compiled form (the driver closes over
  // config.segments + the compiled segments).
  lookupSegment(
    name: string,
  ):
    | { readonly seg: SegmentDecl; readonly compiled: CompiledSegment }
    | undefined;
  // Continue the walk into a child node (parentVisible = this node's
  // visibility; step = which child of how many, extending the address).
  renderChild(
    node: CompiledNode,
    parentVisible: boolean,
    step: AddressStep,
  ): RenderedLines;
  // Continue the walk into the body a segment opens: rendered at the root of
  // the band `band` (the disclosure the trigger computed at entry), visible
  // exactly when the trigger is and `open` holds. Its rows come back unled;
  // the trigger leads them.
  renderBody(
    body: CompiledContainerNode,
    open: boolean,
    band: Disclosure,
  ): RenderedLines;
  // The ✕ that closes the disclosure whose state key is `key`: a link span
  // the trigger lays in its own state colour on every row of the body it
  // opens. Injected so this module never imports the click wire.
  closeDisclosure(key: string): RichText;
}

// [LAW:types-are-the-program] Every Style a segment can wear, resolved at
// entry as one value. `closed` is its authored `bg:`/`fg:`; `trigger` is the
// state colour of the band it opens — what it wears while that band is dropped
// below it; `band` is that band's plane, the floor its dropped lines sit on.
// Which one a line wears is a VALUE the walk selects by the drop's presence,
// never a transform applied after the fact. `disclosure` is the band those
// two were drawn from, returned so the body the segment opens is rendered on
// the SAME band its trigger wears — one read, no second derivation.
export interface SegmentStyles {
  readonly closed: Style;
  readonly trigger: Style;
  readonly band: Style;
  readonly disclosure: Disclosure;
}

// What evaluating one segment's templates produced: the Styles it can wear,
// its inline fragments, and the bodies its open `{{ menu }}`s dropped.
export interface EvaluatedSegment {
  readonly styles: SegmentStyles;
  readonly fragments: readonly RichText[];
  readonly lead: readonly RichText[];
  readonly trail: readonly RichText[];
  readonly drops: readonly RichText[];
  // Whether anything hangs open under the segment — a dropped menu body or
  // its open disclosure body — so it wears its band's state colour.
  readonly open: boolean;
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
//
// Row 0 is a row of the band this container sits on (`own`); a drop keeps the
// band its child gave it — a continuation line of a multi-line segment is that
// segment's `own` row and is led with row 0, a dropped `{{ menu }}` body stays
// `deeper` and is not.
//
// Every `above` line any child carries is lifted out first, in child order,
// and stacked over the composed rest — so it rises through every container to
// the root, and the lines left behind compose exactly as they would without it.
//
// [LAW:one-source-of-truth] Generic over what a line's cells ARE, so the walk's
// rendered cells and `layoutRows`' placed segments are composed by this one rule.
function composeBlocks<C>(
  direction: Direction,
  blocks: ReadonlyArray<ReadonlyArray<Line<C>>>,
): ReadonlyArray<Line<C>> {
  const above = blocks.flatMap((b) => b.filter((l) => l.place === "above"));
  const flow = blocks.map((b) => b.filter((l) => l.place === "flow"));
  return [...above, ...composeFlow(direction, flow)];
}

function composeFlow<C>(
  direction: Direction,
  blocks: ReadonlyArray<ReadonlyArray<Line<C>>>,
): ReadonlyArray<Line<C>> {
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
      const row0: Line<C> = {
        cells: blocks.flatMap((b) => b[0]?.cells ?? []),
        band: "own",
        place: "flow",
      };
      const drops = blocks.flatMap((b) => b.slice(1));
      return [row0, ...drops];
    }
  }
}

// A segment the bar would draw, by name and the address the walk would place
// it at — the layout's own facts, before any template is evaluated.
export interface PlacedSegment {
  readonly name: string;
  readonly address: Address;
  readonly settings: PlacementSettings;
}

// [LAW:one-source-of-truth] The rows a compiled tree lays its CLOSED segments
// out in, composed by the walk's own `composeBlocks` over lines whose cells
// are placed segments, and addressed through the one `childStep` the walk
// extends every address by. A node `shown` refuses contributes no row, and a
// disclosure body is not a child, so a closed bar has none of it. This is the
// ARRANGEMENT — no template is evaluated, so a segment is one block wherever
// the layout places it, however many lines (or none) its template renders.
export function layoutRows(
  node: CompiledNode,
  shown: (node: CompiledNode) => boolean,
): PlacedSegment[][] {
  const lines = (
    n: CompiledNode,
    address: Address,
  ): ReadonlyArray<Line<PlacedSegment>> => {
    if (!shown(n)) return [];
    if (n.kind === "segment") {
      return [
        {
          cells: [{ name: n.name, address, settings: n.settings }],
          band: "own",
          place: "flow",
        },
      ];
    }
    return composeBlocks(
      n.direction,
      n.children.map((child, index) =>
        lines(child, [...address, childStep(n, index)]),
      ),
    );
  };
  return lines(node, []).map((line) => [...line.cells]);
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

// [LAW:one-source-of-truth] THE address step of a container's `index`th child:
// which child of how many, placed by the container's distribution, along the
// axis its direction lays children out on. The walk extends every address
// through this, so a test that computes an expected colour from an address
// calls it too rather than re-spelling the step.
export function childStep(
  node: CompiledContainerNode,
  index: number,
): AddressStep {
  return {
    index,
    count: node.children.length,
    distribution: node.distribution,
    axis: AXIS_OF[node.direction],
  };
}

const containerType: NodeType<"container"> = {
  compile(node, cctx) {
    return {
      kind: "container",
      direction: node.direction,
      when: cctx.when,
      distribution: placedBy(node.distribution),
      children: node.children.map((child, i) =>
        cctx.compileChild(child, childPath(cctx.path, i)),
      ),
    };
  },
  render(node, ctx) {
    // [LAW:dataflow-not-control-flow] Every child is walked, hidden or not:
    // visibility is a value `parentVisible` threads, never a skipped call, and a
    // child's address step is its (index, count) here, placed by THIS
    // container's distribution — unchanged by any sibling's `when`.
    return composeBlocks(
      node.direction,
      node.children.map((child, index) =>
        ctx.renderChild(child, ctx.visible, childStep(node, index)),
      ),
    );
  },
};

// Where each row of an open body goes, by the body's placement.
const BODY_PLACE: Record<
  Placement,
  (line: RenderedLine) => RenderedLine["place"]
> = {
  drop: (line) => line.place,
  above: () => "above",
};

const segmentType: NodeType<"segment"> = {
  compile(node, cctx) {
    return {
      kind: "segment",
      when: cctx.when,
      name: node.name,
      id: placementId(node),
      settings: cctx.placementSettings(node),
      // [LAW:one-source-of-truth] The body's openness is the ref, spelled as a
      // predicate by the one `disclosureGate` every disclosure reads through.
      ...(node.opens !== undefined && {
        opens: {
          open: cctx.parse(disclosureGate(node.opens.ref), "opens"),
          body: cctx.compileChild(node.opens.body, bodyPath(cctx.path)),
          key: node.opens.ref.key,
          placement: node.opens.placement,
        },
      }),
      ...(node.lead !== undefined && {
        lead: cctx.parse(node.lead, "lead"),
      }),
      ...(node.trail !== undefined && {
        trail: cctx.parse(node.trail, "trail"),
      }),
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
    if (!ctx.visible) return [];
    // [LAW:one-source-of-truth] Every template of THIS placement — its
    // segment's `when`, `bg:`, `fg:`, body, and edit mode's lead and trail — reads
    // this placement's settings; nothing outside the placement does.
    const scope = placementScope(ctx.scope, node.settings);

    // [LAW:no-silent-failure] Wrap the whole render body in a try/catch so a
    // partial-load consequence (e.g. a variable that failed to declare, leaving a
    // MissingFieldError when the template or when-predicate accesses it) surfaces
    // as a visible error cell rather than crashing the whole bar. The remaining
    // segments render normally. This is the render-time complement to the per-
    // variable catch in registerDslConfig — together they implement option-2
    // partial rendering: the new config stays active, working segments render, and
    // broken segments show an error cell.
    try {
      if (!evaluateWhen(segCompiled.when, scope)) return [];

      // [LAW:dataflow-not-control-flow] The per-placement variability is
      // WHICH palette, and it is a value: this placement's `theme` setting,
      // the render's palette (the base theme under the style) when it follows
      // the bar, else the named theme, which ignores the style as it ignores
      // the session theme.
      const palette = placementPalette(node.settings.theme, ctx.palette);

      // [LAW:one-source-of-truth] ONE palette for this segment: its `bg:`, its
      // `fg:`, and every `{{ color }}` in its body resolve from this same
      // object. That is the whole reason the segment is entered before its body
      // evaluates rather than after — a body coloured from a palette resolved
      // independently of the cell it sits in is two palettes in one segment,
      // and they diverge the moment a theme or style moves.
      // [LAW:decomposition] The open menu bodies (`drops`) come back beside
      // the fragments, never inside them — invisible to the inline render, so
      // a menu can sit anywhere in the template, under any wrapper, and
      // content after it stays inline. Each becomes one full-width line
      // stacked below the segment's row.
      // The disclosure body this segment opens (a group's, the settings menu's,
      // a `(?)`'s), walked AFTER exit — its cells are segments of their own,
      // each entering the seam in turn — on the band this trigger computed.
      // Walked open or closed, like every child: visibility is a value.
      const bodyOpen =
        node.opens !== undefined && evaluateWhen(node.opens.open, ctx.scope);
      // [LAW:dataflow-not-control-flow] `open` is the PRESENCE of something
      // under the segment: a dropped menu body, or an open disclosure body.
      // Either way the segment is the TRIGGER of the band below it and wears
      // that band's state colour — drawn from what it opens, not from where
      // it sits. The seam decides it (the drop list is only known once the
      // body has evaluated) and evaluates the lead and trail on that ground.
      const { styles, fragments, lead, trail, drops, open } =
        ctx.evaluateSegment(
          node,
          scope,
          palette,
          ctx.region,
          {
            bg: segCompiled.bg,
            fg: segCompiled.fg,
            body: segCompiled.template,
            lead: node.lead,
            trail: node.trail,
          },
          bodyOpen,
        );
      const baseStyle = open ? styles.trigger : styles.closed;
      const layout = {
        width: seg.width ?? "auto",
        justify: seg.justify ?? "left",
        truncate: seg.truncate ?? "right",
        baseStyle,
        // [LAW:dataflow-not-control-flow] Padding is uniform across every line
        // a segment contributes — inline rows AND dropped menu bands — one
        // value, no per-line-kind branch. The picker reserves 2×padding at its
        // pagination seam so a padded band still fits the width budget.
        padding: ctx.padding,
      } as const;
      const opens = node.opens;
      // [LAW:dataflow-not-control-flow] Where the body's rows go is its
      // placement, applied to each row as a value: an `above` body lifts every
      // row; a `drop` body leaves each where it is (a row an `above` body
      // nested inside it lifted stays lifted).
      const bodyLines: RenderedLines =
        opens === undefined
          ? []
          : ctx
              .renderBody(opens.body, bodyOpen, styles.disclosure)
              .map((line) => ({
                ...line,
                place: BODY_PLACE[opens.placement](line),
              }));
      // The ✕ the body this segment opens leads with (brandon-disclosure-43z):
      // one content-sized cell in the trigger's own state colour — the colour
      // the open trigger wears, so the ✕ and the trigger it answers to read as
      // one affordance — laid through the same layout as the trigger's cells,
      // so it pads like them. ONE per body, on its first row: every later row
      // leads with a blank of the same width in the same colour, so the rows
      // stay aligned and read as one panel with one way to close it.
      const leadCell = (text: RichText): readonly LaidCell[] =>
        applySegmentLayout(fragmentsToCells([text], styles.trigger), {
          ...layout,
          width: "auto",
          baseStyle: styles.trigger,
        });
      const firstOwn = bodyLines.findIndex((l) => l.band === "own");
      const close =
        node.opens !== undefined && firstOwn !== -1
          ? ctx.closeDisclosure(node.opens.key)
          : undefined;
      const closeLead = close === undefined ? [] : leadCell(close);
      const holdLead =
        close === undefined
          ? []
          : leadCell(new RichText(" ".repeat(close.cellLength)));
      // [LAW:single-enforcer] The ONE site a body's rows are led: each row of
      // the band this trigger opened gets its lead — the first its ✕, the rest
      // the blank beside it; a row of a band hung deeper inside (a `{{ menu }}`
      // body, a nested disclosure's rows) already has its own and gets none.
      // Every line then returns as a row of a DEEPER band, so the band this
      // trigger sits on never leads it again.
      const leadOf = (line: RenderedLine, i: number): readonly LaidCell[] =>
        line.band !== "own" ? [] : i === firstOwn ? closeLead : holdLead;
      const ledBody: RenderedLines = bodyLines.map((line, i) => ({
        cells: [...leadOf(line, i), ...line.cells],
        band: "deeper",
        place: line.place,
      }));

      // [LAW:single-enforcer] Partition the segment's authored "\n" into visual
      // lines BEFORE per-segment layout — width/justify/truncate then measure each
      // line cleanly. A newline-free segment is the degenerate one-line case. Each
      // laid line is ONE strip item: applySegmentLayout collapses a line's cells to
      // 0-or-1 item (OSC-8 links survive as interior spans), so the joiner caps only
      // at the segment's edges, never inside it.
      // Each inline line is a ROW of the band this segment sits on.
      const inlineLines: RenderedLines = splitCellsIntoLines(
        fragmentsToCells(fragments, baseStyle),
      ).map((line, i) => ({
        cells: applySegmentLayout(line, {
          ...layout,
          lead: i === 0 ? fragmentsToCells(lead, baseStyle) : [],
          trail: i === 0 ? fragmentsToCells(trail, baseStyle) : [],
        }),
        band: "own",
        place: "flow",
      }));
      // Each open menu body is one full-width dropped line on the band's
      // PLANE — the recessed floor its items are placed above — stacked after
      // the inline row(s), a row of that deeper band with the picker's own ✕.
      // composeBlocks then drops every line below row 0 below the enclosing
      // horizontal row.
      const dropLines: RenderedLines = drops.map((body) => ({
        cells: applySegmentLayout(fragmentsToCells([body], styles.band), {
          ...layout,
          baseStyle: styles.band,
        }),
        band: "deeper",
        place: "flow",
      }));
      const laidLines = [...inlineLines, ...dropLines];

      // The sink holds THIS segment's cells — its inline row(s), the menu
      // bands it dropped, and one ✕ per row of the body it led (none when
      // the body laid no row). A disclosure body's cells belong to the
      // segments in it, each of which sinks its own.
      if (ctx.perSegmentSink !== undefined) {
        ctx.perSegmentSink.set(
          node.id,
          [
            ...laidLines.flatMap((line) => line.cells),
            ...bodyLines.flatMap(leadOf),
          ].flatMap(cellParts),
        );
      }
      // Below row 0 every line is a drop: menu bands first (template order),
      // then the disclosure body, in the order they hang under the trigger.
      return [...laidLines, ...ledBody];
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      ctx.onSegmentError?.(node.id, message);
      // The error cell is a row of the band the segment sits on, like any
      // inline line — a broken segment inside an open body still gets its ✕.
      // A cell is one line: the message's own line breaks (a parse error's
      // excerpt, a source's stderr) fold to spaces here — the full text went
      // to onSegmentError above — and the cell is placed whole, never wrapped
      // inside itself, like every other cell.
      const oneLine = message.replace(/\s*\n\s*/g, " ");
      return [
        {
          cells: applySegmentLayout(
            [new RichText(`⚠ ${node.id}: ${oneLine}`, { end: "" })],
            {
              width: "auto",
              justify: "left",
              truncate: "right",
              padding: 0,
              lead: errorAffix(node.lead, node, scope, ctx),
              trail: errorAffix(node.trail, node, scope, ctx),
            },
          ),
          band: "own",
          place: "flow",
        },
      ];
    }
  },
};

// A broken segment stays configurable and removable: edit mode's buttons ride
// its ⚠ cell as they ride any cell. Each is entered as a body of its own, so
// one that fails too is one more reported error beside the first, never a
// bar-wide throw.
function errorAffix(
  affix: Template<RichText> | undefined,
  node: CompiledSegmentNode,
  scope: object,
  ctx: NodeRenderCtx,
): readonly RichText[] {
  if (affix === undefined) return [];
  try {
    return ctx.evaluateSegment(
      node,
      scope,
      ctx.palette,
      ctx.region,
      {
        bg: undefined,
        fg: undefined,
        body: affix,
        lead: undefined,
        trail: undefined,
      },
      false,
    ).fragments;
  } catch (err) {
    ctx.onSegmentError?.(node.id, (err as Error).message ?? String(err));
    return [];
  }
}

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
