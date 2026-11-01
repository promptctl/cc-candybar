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
import type { ColorRgba, Palette, Style } from "@promptctl/rich-js";
import type { Template } from "@promptctl/go-template-js";
import type {
  ContainerNode,
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
import { groundOf } from "../template-engine/colors.js";
import { FOLLOW_BAR, type PlacementEffect } from "../themes/policy.js";
import { disclosureGate } from "../config/disclosure.js";
import { splitCellsIntoLines } from "../render/split-lines.js";
import {
  placedBy,
  type Address,
  type AddressStep,
  type Disclosure,
  type Region,
} from "../themes/decor.js";
import {
  fragmentsToCells,
  applySegmentLayout,
  placementScope,
} from "../template-engine/index.js";
import {
  cellParts,
  heldCell,
  HIDDEN,
  type Gate,
  type LaidCell,
} from "../template-engine/layout.js";
import type { PlacementRecord, Returned } from "../render/frame-memory.js";
import { readPending } from "../var-system/types.js";

// ─── Compiled node shapes ──────────────────────────────────────────────────────

// [LAW:dataflow-not-control-flow] The compiled mirror of a LayoutNode: the same
// recursive shape with every `when` parsed ONCE at registration. drawDsl walks
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
  // [LAW:parse-dont-validate] The step each child is placed at, by index,
  // worked out ONCE from the authored tree (`placeChildren`): its place among
  // the rows, or on its row's line, with the distribution that places it —
  // so the walk never re-reads the config or measures a sibling.
  readonly steps: readonly AddressStep[];
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

// Which row each line is, as a name stable while lines of other kinds come and
// go: its place and band, and how many lines of that kind came before it. A bar
// row stays `flow.own#1` whether the settings door's body (`above`) or a dropped
// menu (`deeper`) is drawn over it or not.
export function rowIdentities<C>(
  lines: ReadonlyArray<Line<C>>,
): Array<{ readonly line: Line<C>; readonly row: string }> {
  const counts = new Map<string, number>();
  return lines.map((line) => {
    const kind = `${line.place}.${line.band}`;
    const nth = counts.get(kind) ?? 0;
    counts.set(kind, nth + 1);
    return { line, row: `${kind}#${nth}` };
  });
}

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
  // The step THIS node is placed at in its parent (`placeChildren`): none at
  // a root — the bar's, or a disclosure body's, which roots a band.
  readonly at: AddressStep | undefined;
  // Parse one more template field of THIS node through the driver's one
  // parse site, so its error names `path.field` like a `when` does.
  parse(src: string, field: string): Template<RichText>;
  // Compile a child node placed at `at` (the recursion, injected so this
  // module needn't import the driver). Generic so a container child compiles
  // to a container.
  compileChild<N extends LayoutNode>(
    node: N,
    path: string,
    at: AddressStep | undefined,
  ): Compiled<N>;
  // The resolved settings of a segment placement: the driver holds the
  // declarations they resolve against.
  placementSettings(node: SegmentNode): PlacementSettings;
}

// What a placement's templates read as `.settings`: a frozen, null-prototype
// record, so no inherited name resolves as a setting. The implied settings are
// always there (settingsOf), each a member of the domain it resolves against:
// `theme` a theme's name or `bar`, `effect` an effect's name or `bar`.
export type PlacementSettings = Readonly<Record<string, SettingValue>> & {
  readonly theme: string;
  readonly effect: PlacementEffect;
};

// [LAW:types-are-the-program] A node's own `when` as the driver evaluated it,
// a failure carrying the one way to say so: only a gate that failed can be
// reported, and only with its own error.
export type NodeGate =
  | Exclude<Gate, { kind: "failed" }>
  | (Extract<Gate, { kind: "failed" }> & { report(): void });

// [LAW:dataflow-not-control-flow] What a node's gate makes of the nodes it
// holds, threaded down the walk as a value: shown (each asks its own `when`),
// hidden, or not answered yet — each placement under it draws where it stood.
// A gate that failed decides nothing, so what it holds is hidden.
export type Visibility = Exclude<Gate, { kind: "failed" }>;

const visibilityOf = (gate: NodeGate): Visibility =>
  gate.kind === "failed" ? HIDDEN : gate;

// A node's own gate under a parent that is shown, or not answered yet. Under
// one not answered yet, a node its own `when` hides is hidden either way, and
// one waiting itself waits; one it shows waits on the parent, and so does one
// whose `when` fails — no fault yet, since the parent's answer decides whether
// it is asked at all.
export function within(parent: Visibility, own: Gate): Gate {
  return own.kind === "shown" ||
    (own.kind === "failed" && parent.kind === "pending")
    ? parent
    : own;
}

// [LAW:single-enforcer] The render-time context. `gate` is THIS node's own
// `when` as the driver evaluated it — hidden, unevaluated, under a parent that
// is not shown. renderChild continues the walk.
export interface NodeRenderCtx {
  // The render's scope. A placement's own templates evaluate in it with
  // `.settings` bound (`placementScope`); everything else reads it as is.
  readonly scope: object;
  // [LAW:one-source-of-truth] The render's palette: the base theme (session
  // choice over config default) under the render's style, transposed ONCE by
  // the driver — every unpinned segment colours from this one object.
  readonly palette: Palette;
  readonly gate: NodeGate;
  // [LAW:one-source-of-truth] The render-wide intra-cell padding (resolved
  // globals.padding), threaded by the driver from BuildLineOptions into every
  // segment's layout — one value per render, never re-defaulted per node.
  readonly padding: number;
  // [LAW:effects-at-boundaries] THIS node's region: the bar with the
  // (index, count) steps from the root, or the band a disclosure body hangs
  // on with the steps since that body — extended by one step per container
  // level by the driver, re-rooted onto a band by `renderBody`. A pure fact
  // about position — unchanged by any node being hidden — that the segment
  // hands its parts (`PlacementParts.evaluate`) so its colours derive from where it sits, with no
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
  // module never imports the menu or color features — it only names a
  // placement and gets back its parts as the view keeps them
  // (src/dsl/parts.ts): its own `when`, whether the body it hangs is open,
  // and what its templates evaluate to where the walk draws it.
  placement(node: CompiledSegmentNode): PlacementParts;
  // A template of the placement evaluated once, kept nowhere, as its body
  // would be in `palette` on this node's region: a broken placement's edit
  // buttons, drawn beside its ⚠.
  evaluateOnce(
    node: CompiledSegmentNode,
    scope: object,
    palette: Palette,
    body: Template<RichText>,
  ): EvaluatedSegment;
  // Resolve a segment name to its declaration (the driver closes over
  // config.segments).
  lookupSegment(name: string): SegmentDecl | undefined;
  // Continue the walk into a child node (held = what this node's gate makes
  // of it; step = which child of how many, extending the address).
  renderChild(
    node: CompiledNode,
    held: Visibility,
    step: AddressStep,
  ): RenderedLines;
  // Continue the walk into the body a segment opens: rendered at the root of
  // the band `band` (the disclosure the trigger computed at entry), `held` as
  // the trigger's gate makes of it — hidden while it is closed. Its rows come
  // back unled; the trigger leads them.
  renderBody(
    body: CompiledContainerNode,
    held: Visibility,
    band: Disclosure,
  ): RenderedLines;
  // The ✕ that closes the disclosure whose state key is `key`: a link span
  // the trigger lays in its own state colour on every row of the body it
  // opens. Injected so this module never imports the click wire.
  closeDisclosure(key: string): RichText;
  // [LAW:locality-or-seam] The session's record of what the last frame drew,
  // as the walk meets it: a placement reports the lines it drew this frame and
  // returns what comes back — those, or, while it dissolves off the bar, the
  // rows it last drew in place of its own (`SessionEffects.motion`,
  // brandon-effects-2gka.3vt).
  placed(id: string, lines: RenderedLines): RenderedLines;
  // What the view's last drawn frame showed of the placement `id`: none in a
  // view that has drawn none, or where the walk never reached it.
  lastDrawn(id: string): PlacementRecord<RenderedLine> | undefined;
  // A source whose value this frame drew as not answered yet.
  waited(variable: string): void;
  // The styles the placement's region deals it in `palette`, its authored
  // colours unread.
  decorations(node: CompiledSegmentNode, palette: Palette): SegmentStyles;
}

// [LAW:one-source-of-truth] The lines the placement `id` returned, divided as
// the view's frame record keeps them, in one pass: what it drew — its own
// rows, whether it opened anything under them, and the ground its cells fade
// from — or nothing, when it laid no cell, and the rows of the deeper bands
// hung under it.
export function returnedBy(
  id: string,
  lines: RenderedLines,
): Returned<RenderedLine> {
  const own: RenderedLine[] = [];
  const deeper: RenderedLine[] = [];
  let ground: ColorRgba | undefined;
  for (const line of lines) {
    (line.band === "own" ? own : deeper).push(line);
    ground ??= line.cells.find((cell) => cell.placement.id === id)?.placement
      .ground;
  }
  return {
    drawing:
      ground === undefined ? null : { own, opened: deeper.length > 0, ground },
    deeper,
  };
}

// One row a placement leaving the bar replays of what it last drew: each cell
// as it was drawn, with nothing to click (`heldCell`).
export function heldLine(line: RenderedLine): RenderedLine {
  return { ...line, cells: line.cells.map(heldCell) };
}

// [LAW:types-are-the-program] Every Style a segment can wear, resolved at
// entry as one value. `closed` is its authored `bg:`/`fg:`; `trigger` is the
// state colour of the band it opens — what it wears while that band is dropped
// below it; `band` is that band's plane, the floor its dropped lines sit on;
// `close` is the trigger's ground with the close glyph's text, which the ✕
// leading the body it opens wears. Which one a line wears is a VALUE the walk selects by the drop's presence,
// never a transform applied after the fact. `disclosure` is the band those
// two were drawn from, returned so the body the segment opens is rendered on
// the SAME band its trigger wears — one read, no second derivation.
export interface SegmentStyles {
  readonly closed: Style;
  readonly trigger: Style;
  readonly band: Style;
  readonly close: Style;
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

// [LAW:one-source-of-truth] A placement's parts as its view keeps them
// (src/dsl/parts.ts): its segment's own `when`, whether the body it hangs is
// open, and what its templates evaluate to in the palette and region the walk
// draws it in — each a derived value of the view, so a frame between data
// changes evaluates only the parts that read the instant. A part that throws
// throws at every read until what it read changes.
export interface PlacementParts {
  gate(): Gate;
  bodyGate(): Gate;
  evaluate(palette: Palette, region: Region): EvaluatedSegment;
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

// [LAW:one-source-of-truth] THE address step of a container's `index`th child,
// as the compile placed it (`placeChildren`). The walk extends every address
// through this, so a test that computes an expected colour from an address
// calls it too rather than re-spelling the step.
export function childStep(
  node: CompiledContainerNode,
  index: number,
): AddressStep {
  // [LAW:no-defensive-null-guards] The compile places every child, and every
  // caller reads an index the container has; the `!` states that, it does not
  // guard it.
  return node.steps[index]!;
}

// What a node takes along the line it is drawn on: `width`, the places on
// its first line, so its next sibling starts that many places on; `reach`,
// the places it spans over every line it draws, so every leaf it holds is
// placed within its row's count. A segment takes one place, and so does a
// unit, whose children share it. A horizontal container lays its children
// side by side. A vertical one draws its first child that draws a line on the
// line it sits on, and each child after it on a line of its own below,
// starting where it sits: a row zips its children's first lines and stacks
// every further line under them, and an empty container draws no line at
// all (`composeFlow`).
interface Span {
  readonly width: number;
  readonly reach: number;
}

// A child's span, the place it starts at, counted from its container's, and
// whether it is drawn on a line of its own: a child of a vertical container
// once an earlier child has drawn a line.
interface Laid {
  readonly start: number;
  readonly span: Span;
  readonly ownLine: boolean;
}

function spanOf(node: LayoutNode): Span {
  if (node.kind === "segment" || node.unit === true) {
    return { width: 1, reach: 1 };
  }
  const laid = laidOut(node);
  return { width: widthOf(laid), reach: reachOf(laid) };
}

// A container's children, each with where it starts: side by side in a
// horizontal container; all where the container sits in a unit, whose
// children share one place, and in a vertical one, whose children each start
// a line.
function laidOut(node: ContainerNode): Laid[] {
  const spans = node.children.map(spanOf);
  const ownLine = (index: number): boolean =>
    node.direction === "vertical" &&
    spans.slice(0, index).some(({ width }) => width > 0);
  if (node.direction === "vertical" || node.unit === true) {
    return spans.map((span, i) => ({ start: 0, span, ownLine: ownLine(i) }));
  }
  let start = 0;
  return spans.map((span, i) => {
    const at = start;
    start += span.width;
    return { start: at, span, ownLine: ownLine(i) };
  });
}

// The places on a container's first line: those of the children drawn on
// it, so none for a container that draws no line.
const widthOf = (laid: readonly Laid[]): number =>
  laid.reduce((sum, { span, ownLine }) => sum + (ownLine ? 0 : span.width), 0);

const reachOf = (laid: readonly Laid[]): number =>
  laid.reduce((most, { start, span }) => Math.max(most, start + span.reach), 0);

// [LAW:single-enforcer] THE placement of a container's children, worked out
// from the authored tree when it is compiled, so a node's step — and with it
// its colour — is a fact of the tree alone: no sibling's `when` moves it.
// Among the rows, a vertical container stacks its children as rows, one step
// each, placed by its own distribution. A horizontal one there is a ROW, and
// places every leaf it holds by its own distribution, at the leaf's place on
// the line: a container nested in a row is layout, not a colour unit, because
// the cells in it sit side by side with the row's other cells, and two cells
// side by side must differ. Under a row every step is a cell step at a place
// on its line. It carries the row's count and distribution, which is why the
// loader refuses a `distribution` written inside a row, and the ends of the
// line it is drawn on (the row's own, or one a `{ v }` starts below it), so
// the keystones find the first and last leaf of every drawn line. A unit —
// edit chrome around one content cell — is the one container that keeps its
// children on one place, so entering edit mode recolours nothing.
function placeChildren(
  node: ContainerNode,
  at: AddressStep | undefined,
): AddressStep[] {
  const laid = laidOut(node);
  if (at?.axis === "cell") {
    return laid.map(({ start, span, ownLine }) => {
      const index = at.index + start;
      return ownLine
        ? { ...at, index, lineStart: index, lineEnd: index + span.width - 1 }
        : { ...at, index };
    });
  }
  const axis = AXIS_OF[node.direction];
  const distribution = placedBy(node.distribution);
  // Rows are a stack, from the first to the last; a row's cells are on its
  // line, which ends at the last place its first line holds.
  const [places, count, lineEnd] =
    axis === "row"
      ? [laid.map((_, index) => index), laid.length, laid.length - 1]
      : [laid.map(({ start }) => start), reachOf(laid), widthOf(laid) - 1];
  return places.map((index) => ({
    index,
    count,
    distribution,
    axis,
    lineStart: 0,
    lineEnd,
  }));
}

const containerType: NodeType<"container"> = {
  compile(node, cctx) {
    const steps = placeChildren(node, cctx.at);
    return {
      kind: "container",
      direction: node.direction,
      when: cctx.when,
      steps,
      children: node.children.map((child, i) =>
        cctx.compileChild(child, childPath(cctx.path, i), steps[i]),
      ),
    };
  },
  render(node, ctx) {
    // [LAW:no-silent-failure] A gate that failed decides nothing, so what it
    // gates is hidden: a broken `when` costs its own container, never the bar
    // (brandon-unfiled-3248.ryf). A container has no cell to show a ⚠ in, so
    // it reports the failure instead.
    if (ctx.gate.kind === "failed") ctx.gate.report();
    // [LAW:dataflow-not-control-flow] Every child is walked, hidden or not:
    // visibility is a value `parentVisible` threads, never a skipped call, and a
    // child's address step is the one the compile placed it at — unchanged by
    // any sibling's `when`.
    return composeBlocks(
      node.direction,
      node.children.map((child, index) =>
        ctx.renderChild(child, visibilityOf(ctx.gate), childStep(node, index)),
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

// [LAW:dataflow-not-control-flow] What leads the first row of an open body,
// by the body's placement, and what of the trigger's own rows stays where the
// trigger sits. A `drop` body hangs under a trigger that stays on its row, so
// the body's row leads with a ✕. An `above` body lifts over the whole bar and
// its trigger rises with it: the trigger's own row becomes that lead — the
// body's one close, its click the trigger's — and leaves the row it sat on.
const OPEN_LEAD: Record<
  Placement,
  (
    inline: RenderedLines,
    close: () => readonly LaidCell[],
  ) => { readonly lead: readonly LaidCell[]; readonly stays: RenderedLines }
> = {
  drop: (inline, close) => ({ lead: close(), stays: inline }),
  above: (inline) => ({
    lead: inline.slice(0, 1).flatMap((line) => line.cells),
    stays: inline.slice(1),
  }),
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
          // A body roots a band: its first step is placed afresh.
          body: cctx.compileChild(
            node.opens.body,
            bodyPath(cctx.path),
            undefined,
          ),
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
  // [LAW:dataflow-not-control-flow] Every way a placement's drawing ends —
  // hidden, gated off, drawn, broken — is reported to the session's record, so
  // one that stops drawing leaves the bar as it was last drawn.
  render: (node, ctx) => ctx.placed(node.id, drawSegment(node, ctx)),
};

// What one placement draws this frame: nothing, its rows (with the menus it
// drops and the body it opens hung under them), or the ⚠ cell its failure is.
function drawSegment(
  node: CompiledSegmentNode,
  ctx: NodeRenderCtx,
): RenderedLines {
  const seg = ctx.lookupSegment(node.name);
  // [LAW:no-defensive-null-guards] The loader validates every segment ref
  // against the segments map; a miss is a caller bug (drawDsl given a
  // mismatched config).
  if (seg === undefined) {
    throw new Error(`Layout segment "${node.name}" has no matching segment`);
  }
  if (ctx.gate.kind === "hidden") return [];
  // [LAW:one-source-of-truth] Every template of THIS placement — its
  // segment's `when`, `bg:`, `fg:`, body, and edit mode's lead and trail — reads
  // this placement's settings; nothing outside the placement does.
  const scope = placementScope(ctx.scope, node.settings);
  // The gate on the placement (`{ seg, when }`) failing is the placement's
  // failure, drawn as its segment's own `when` failing is.
  if (ctx.gate.kind === "failed") {
    return brokenSegment(node, scope, ctx, ctx.gate.message);
  }

  // [LAW:no-silent-failure] Wrap the whole render body in a try/catch so a
  // partial-load consequence (e.g. a variable that failed to declare, leaving a
  // MissingFieldError when the template or when-predicate accesses it) surfaces
  // as a visible error cell rather than crashing the whole bar. The remaining
  // segments render normally. This is the render-time complement to the per-
  // variable catch in registerDslConfig — together they implement option-2
  // partial rendering: the new config stays active, working segments render, and
  // broken segments show an error cell.
  try {
    const parts = ctx.placement(node);
    // Its own `when` under the gate over it: one not answered yet waits, and
    // so does one its own `when` shows under a gate not answered yet.
    const gate = within(ctx.gate, parts.gate());
    if (gate.kind === "failed") {
      return brokenSegment(node, scope, ctx, gate.message);
    }
    if (gate.kind === "hidden") return [];
    // The gate of the body it hangs: one that fails is the placement's
    // failure; one not answered yet leaves the placement waiting on it, with
    // nothing hung under it. Under a gate not answered yet, one that fails is
    // no fault yet, as `within` reads a `when`: it waits on that gate.
    const ownBodyGate = parts.bodyGate();
    const bodyGate =
      ownBodyGate.kind === "failed" && gate.kind === "pending"
        ? gate
        : ownBodyGate;
    if (bodyGate.kind === "failed") {
      return brokenSegment(node, scope, ctx, bodyGate.message);
    }

    // [LAW:dataflow-not-control-flow] The per-placement variability is
    // WHICH palette, and it is a value: this placement's `theme` setting,
    // the render's palette (the base theme under the style) when it follows
    // the bar, else the named theme, which ignores the style as it ignores
    // the session theme.
    // [LAW:one-source-of-truth] ONE palette for this segment: its `bg:`, its
    // `fg:`, and every `{{ color }}` in its body resolve from this same
    // object. That is the whole reason the segment is entered before its body
    // evaluates rather than after — a body coloured from a palette resolved
    // independently of the cell it sits in is two palettes in one segment,
    // and they diverge the moment a theme or style moves.
    const palette = placementPalette(node.settings.theme, ctx.palette);
    // Every cell this placement lays is its own — its inline rows, the menu
    // bands it drops, the lead of each row of the body it opens — and names
    // it: its `effect` setting moves every one (the per-segment sink's
    // cells), and every one fades in from its palette's ground when the
    // placement appears.
    const placement = {
      id: node.id,
      effect: node.settings.effect,
      ground: groundOf(palette),
    };
    const layoutOf = (baseStyle: Style) =>
      ({
        width: seg.width ?? "auto",
        justify: seg.justify ?? "left",
        truncate: seg.truncate ?? "right",
        baseStyle,
        // [LAW:dataflow-not-control-flow] Padding is uniform across every
        // line a segment contributes — inline rows AND dropped menu bands —
        // one value, no per-line-kind branch. The picker reserves 2×padding
        // at its pagination seam so a padded band still fits the width
        // budget.
        padding: ctx.padding,
        placement,
      }) as const;

    // The disclosure body this segment opens (a group's, the settings menu's,
    // a `(?)`'s), walked AFTER exit — its cells are segments of their own,
    // each entering the seam in turn — on the band this trigger computed.
    // Walked open or closed, like every child: visibility is a value.
    const bodyOpen = bodyGate.kind === "shown";
    // [LAW:dataflow-not-control-flow] What the placement's own templates
    // answer: their rows, or — not answered yet — the rows it stood in. Either
    // way the body it hangs open is hung under them, so a placement waiting on
    // a source leaves what is open under it open, and drawn.
    const waits = gate.kind === "pending" ? gate : bodyGate;
    const own =
      waits.kind === "pending"
        ? waitingOn(waits.variable)
        : ownAnswer(() => parts.evaluate(palette, ctx.region));
    const drawn =
      own.kind === "drawn"
        ? drawnRows(own.segment, layoutOf)
        : waitingRows(
            node,
            scope,
            ctx,
            own.variable,
            palette,
            bodyOpen,
            layoutOf,
          );
    if (drawn === null) return [];
    const { styles, inline: inlineLines, drops: dropLines } = drawn;

    const opens = node.opens;
    // [LAW:dataflow-not-control-flow] Where the body's rows go is its
    // placement, applied to each row as a value: an `above` body lifts every
    // row; a `drop` body leaves each where it is (a row an `above` body
    // nested inside it lifted stays lifted). It is held as this placement's
    // own gate holds it — shown, or not answered yet — and hidden while closed.
    const bodyLines: RenderedLines =
      opens === undefined
        ? []
        : ctx
            .renderBody(opens.body, bodyOpen ? gate : HIDDEN, styles.disclosure)
            .map((line) => ({
              ...line,
              place: BODY_PLACE[opens.placement](line),
            }));
    // The lead of the body this segment opens (brandon-disclosure-43z), in
    // the trigger's own state colour — the colour the open trigger wears, so
    // the lead and the trigger it answers to read as one affordance. ONE per
    // body, on its first row: every later row leads with a blank of each of
    // its cells' widths in the same colour, so the rows stay aligned and read
    // as one panel with one way to close it.
    const leadCell = (
      text: RichText,
      style: Style,
      padding: number,
    ): readonly LaidCell[] =>
      applySegmentLayout(fragmentsToCells([text], style), {
        ...layoutOf(style),
        width: "auto",
        padding,
      });
    const firstOwn = bodyLines.findIndex((l) => l.band === "own");
    const { lead: openLead, stays } =
      opens !== undefined && firstOwn !== -1
        ? OPEN_LEAD[opens.placement](inlineLines, () =>
            leadCell(ctx.closeDisclosure(opens.key), styles.close, ctx.padding),
          )
        : { lead: [], stays: inlineLines };
    const holdLead = openLead.flatMap((cell) =>
      leadCell(
        new RichText(" ".repeat(cellsWidth(cellParts(cell)))),
        styles.trigger,
        0,
      ),
    );
    // [LAW:single-enforcer] The ONE site a body's rows are led: each row of
    // the band this trigger opened gets its lead — the first its close, the
    // rest the blank beside it; a row of a band hung deeper inside (a
    // `{{ menu }}` body, a nested disclosure's rows) already has its own and
    // gets none. Every line then returns as a row of a DEEPER band, so the
    // band this trigger sits on never leads it again.
    const leadOf = (line: RenderedLine, i: number): readonly LaidCell[] =>
      line.band !== "own" ? [] : i === firstOwn ? openLead : holdLead;
    const ledBody: RenderedLines = bodyLines.map((line, i) => ({
      cells: [...leadOf(line, i), ...line.cells],
      band: "deeper",
      place: line.place,
    }));

    const laidLines = [...stays, ...dropLines];

    // The sink holds THIS segment's cells — the inline row(s) it left
    // where it sits, the menu bands it dropped, and the lead of each row of
    // the body it led (none when the body laid no row) — a risen trigger's
    // row among them. A disclosure body's cells belong to the
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
    return brokenSegment(
      node,
      scope,
      ctx,
      (err as Error).message ?? String(err),
    );
  }
}

// What a placement's own templates answer in one frame: what they evaluated
// to, or not answered yet — they read `variable`, whose source has not.
type OwnAnswer =
  | { readonly kind: "drawn"; readonly segment: EvaluatedSegment }
  | { readonly kind: "waiting"; readonly variable: string };

const waitingOn = (variable: string): OwnAnswer => ({
  kind: "waiting",
  variable,
});

// [LAW:single-enforcer] `readPending` is the one thing that tells not answered
// yet from a failure, which the caller's catch draws as the ⚠ it is.
function ownAnswer(evaluate: () => EvaluatedSegment): OwnAnswer {
  try {
    return { kind: "drawn", segment: evaluate() };
  } catch (err) {
    const pending = readPending(err);
    if (pending === undefined) throw err;
    return waitingOn(pending.variable);
  }
}

type Layout = Parameters<typeof applySegmentLayout>[1];

// A placement's own rows and the menus it drops, and the styles it wears —
// among them the band the body it opens hangs on.
interface OwnRows {
  readonly styles: SegmentStyles;
  readonly inline: RenderedLines;
  readonly drops: RenderedLines;
}

// The rows a placement's evaluated templates lay: its inline row(s), and each
// menu it drops as one full-width line beneath them.
function drawnRows(
  segment: EvaluatedSegment,
  layoutOf: (baseStyle: Style) => Layout,
): OwnRows {
  // [LAW:dataflow-not-control-flow] `open` is the PRESENCE of something
  // under the segment: a dropped menu body, or an open disclosure body.
  // Either way the segment is the TRIGGER of the band below it and wears
  // that band's state colour — drawn from what it opens, not from where
  // it sits. The seam decides it (the drop list is only known once the
  // body has evaluated) and evaluates the lead and trail on that ground.
  const { styles, fragments, lead, trail, drops, open } = segment;
  const baseStyle = open ? styles.trigger : styles.closed;
  const layout = layoutOf(baseStyle);
  // [LAW:single-enforcer] Partition the segment's authored "\n" into visual
  // lines BEFORE per-segment layout — width/justify/truncate then measure each
  // line cleanly. A newline-free segment is the degenerate one-line case. Each
  // laid line is ONE strip item, until its row divides one wider than a line:
  // applySegmentLayout collapses a line's cells to
  // 0-or-1 item (OSC-8 links survive as interior spans), so the joiner caps only
  // at the segment's edges, never inside it.
  // Each inline line is a ROW of the band this segment sits on.
  const inline: RenderedLines = splitCellsIntoLines(
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
  // [LAW:decomposition] The open menu bodies (`drops`) come back beside
  // the fragments, never inside them — invisible to the inline render, so
  // a menu can sit anywhere in the template, under any wrapper, and
  // content after it stays inline.
  // Each open menu body is one full-width dropped line on the band's
  // PLANE — the recessed floor its items are placed above — stacked after
  // the inline row(s), a row of that deeper band with the picker's own ✕.
  // composeBlocks then drops every line below row 0 below the enclosing
  // horizontal row.
  return {
    styles,
    inline,
    drops: drops.map((body) => ({
      cells: applySegmentLayout(fragmentsToCells([body], styles.band), {
        ...layout,
        baseStyle: styles.band,
      }),
      band: "deeper",
      place: "flow",
    })),
  };
}

// The glyph a placement whose value is not answered yet draws: the marker a
// truncated cell already ends in.
export const LOADING_GLYPH = "…";

// [LAW:no-silent-failure] A placement whose value is not answered yet draws
// where it stood in the view's last frame drawn from this source, so in a view
// that drew it a source answering late reflows nothing: one that drew holds
// each cell it laid at the width it drew, `…` in the first, one that drew
// nothing still draws nothing (null), and one never drawn (a cold view) is one
// cell. It wears its decoration — a pending value states no meaning for a
// `bg:` to paint — as the trigger of the body it hangs open, and edit mode's
// buttons ride it as they ride any cell, so it stays configurable and
// removable. What its templates would drop is not known until they answer, so
// it drops nothing.
function waitingRows(
  node: CompiledSegmentNode,
  scope: object,
  ctx: NodeRenderCtx,
  variable: string,
  palette: Palette,
  bodyOpen: boolean,
  layoutOf: (baseStyle: Style) => Layout,
): OwnRows | null {
  ctx.waited(variable);
  const last = ctx.lastDrawn(node.id);
  if (last?.kind === "hidden") return null;
  const styles = ctx.decorations(node, palette);
  const style = bodyOpen ? styles.trigger : styles.closed;
  const lead = fragmentsToCells(errorAffix(node.lead, node, scope, ctx), style);
  const trail = fragmentsToCells(
    errorAffix(node.trail, node, scope, ctx),
    style,
  );
  // [LAW:one-source-of-truth] The shape it drew, cell for cell: each laid
  // cell's content — padding included, fill grown in place, measured once its
  // row serialized — is the width `applySegmentLayout` sizes content to, beside
  // the lead and trail it lays around it. One that drew no row of its own — a
  // trigger whose row rose to lead the body it opens `above` — stands as one
  // cell, as in a cold view, so it still leads that body.
  const rows: ReadonlyArray<ReadonlyArray<number | "auto">> =
    last === undefined || last.drawing.own.length === 0
      ? [["auto"]]
      : last.drawing.own.map((line) =>
          line.cells.map((cell) => cell.text.cellLength),
        );
  return {
    styles,
    inline: rows.map((widths, row) => ({
      cells: widths.flatMap((width, i) => {
        const first = row === 0 && i === 0;
        return applySegmentLayout(
          fragmentsToCells([new RichText(first ? LOADING_GLYPH : " ")], style),
          {
            ...layoutOf(style),
            width,
            justify: "left",
            truncate: "right",
            lead: first ? lead : [],
            trail: first ? trail : [],
          },
        );
      }),
      band: "own",
      place: "flow",
    })),
    drops: [],
  };
}

function cellsWidth(cells: readonly RichText[]): number {
  return cells.reduce((width, cell) => width + cell.cellLength, 0);
}

// The ⚠ cell a broken placement draws in place of everything it would have.
function brokenSegment(
  node: CompiledSegmentNode,
  scope: object,
  ctx: NodeRenderCtx,
  message: string,
): RenderedLines {
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
          // It follows the bar, and fades in from the bar's ground: the
          // failure it reports may be the read of this placement's own
          // settings.
          placement: {
            id: node.id,
            effect: FOLLOW_BAR,
            ground: groundOf(ctx.palette),
          },
          lead: errorAffix(node.lead, node, scope, ctx),
          trail: errorAffix(node.trail, node, scope, ctx),
        },
      ),
      band: "own",
      place: "flow",
    },
  ];
}

// A broken segment stays configurable and removable: edit mode's buttons ride
// its ⚠ cell as they ride any cell. Each is entered as a body of its own, so
// one that fails too is one more reported error beside the first, never a
// bar-wide throw; one not answered yet is no error, and draws nothing until it
// is.
function errorAffix(
  affix: Template<RichText> | undefined,
  node: CompiledSegmentNode,
  scope: object,
  ctx: NodeRenderCtx,
): readonly RichText[] {
  if (affix === undefined) return [];
  try {
    return ctx.evaluateOnce(node, scope, ctx.palette, affix).fragments;
  } catch (err) {
    // [LAW:single-enforcer] `readPending` is the one thing that tells them apart.
    const pending = readPending(err);
    if (pending !== undefined) ctx.waited(pending.variable);
    else ctx.onSegmentError?.(node.id, (err as Error).message ?? String(err));
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
