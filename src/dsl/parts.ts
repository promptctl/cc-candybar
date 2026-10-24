// [LAW:one-source-of-truth] A view's parts (brandon-unfiled-3248.8ro6, step
// 6): every template a draw evaluates — a layout node's `when`, a placement's
// own `when`, the gate of the body it hangs, its `bg:` and `fg:`, its body, its
// lead and trail, each globals rule, and the rows `{{ layoutPreview }}` lays
// out — held as a derived value of the store the view draws from. A part that
// reads the instant is a projection, derived by every draw; every other part
// keeps its answer until something it read changes. So a frame drawn between
// data changes evaluates the parts that read the instant and nothing else.
//
// [LAW:no-ambient-temporal-coupling] Everything a part reads is something it
// tracks: the store's values through the view's one scope, and the draw's own
// facts — the strip's geometry, the preset, the look, and the palette and
// region the walk draws a placement in — as observables each draw writes
// before it reads a part. A write of what was already there changes nothing,
// so a frame drawn from what the last one was drawn from wakes no part.
//
// The set is closed upward, as the variables' is (projections.ts): a part that
// reads a projection part is one — a body reads its segment's colours, and its
// lead and trail read whether the body opened.

import { observable, runInAction } from "mobx";
import type {
  ColorDepth,
  ColorRgba,
  Palette,
  RichText,
  Style,
} from "@promptctl/rich-js";
import type { Template } from "@promptctl/go-template-js";
import type { Derived, VariableStore } from "../var-system/store.js";
import type { SourceRegistry } from "../var-system/sources.js";
import { buildScope, placementScope } from "../template-engine/scope.js";
import { is, sameBy } from "../utils/same.js";
import {
  evaluateWhen,
  gateOf,
  resolveSegmentColors,
} from "../template-engine/index.js";
import type { Gate } from "../template-engine/layout.js";
import {
  inSegment,
  outsideSegments,
  type ActiveSegmentRef,
} from "../render/active-segment.js";
import type {
  PreviewRows,
  RenderBinding,
  RenderLook,
} from "../render/action.js";
import { closeCell, stateCell } from "../render/band-style.js";
import { arrangedSegment } from "../config/edit-chrome.js";
import { placementPalette } from "../themes/index.js";
import {
  bandFor,
  decorationFor,
  sameDecor,
  sameDisclosure,
  sameRegion,
  type Disclosure,
  type Region,
} from "../themes/decor.js";
import {
  layoutRows,
  type CompiledNode,
  type CompiledSegmentNode,
  type CompiledSegments,
  type EvaluatedSegment,
  type PlacementParts,
  type RenderedLine,
} from "./node-registry.js";
import { FrameMemory } from "../render/frame-memory.js";
import { readPending } from "../var-system/types.js";

// What of a compile its parts are evaluated from.
export interface PartsSource {
  readonly segments: CompiledSegments;
  readonly roots: ReadonlyMap<string, CompiledNode>;
  readonly activeSegment: ActiveSegmentRef;
  // The templates that read the instant, and whether the layout does.
  readonly instant: ReadonlySet<Template<RichText>>;
  readonly layoutReadsInstant: boolean;
}

// The draw's own facts a part may read beside the store: the strip's geometry,
// and the preset whose rows a layout lays out.
export interface DrawFacts {
  readonly width: number;
  readonly chromeCols: number;
  readonly padding: number;
  readonly seamCols: number;
  readonly preset: string;
}

// What a globals rule evaluated to: the name it wrote, not yet — it reads
// `variable`, whose source has not answered — or why it threw.
export type RuleOutcome =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "pending"; readonly variable: string }
  | { readonly kind: "failed"; readonly error: string };

// A derivation's answer, its throw included: a part that throws throws again
// at every read of that answer, as a kept one does.
type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

function answerOf<T>(deriver: () => T): Answer<T> {
  try {
    return { ok: true, value: deriver() };
  } catch (error) {
    return { ok: false, error };
  }
}

function unwrap<T>(answer: Answer<T>): T {
  if (answer.ok) return answer.value;
  throw answer.error;
}

// [LAW:one-type-per-behavior] A value no template computes, read as a part is.
const always = <T>(value: T): Derived<T> => ({ read: () => value });

const sameLook = sameBy<RenderLook>({
  basePalette: is,
  palette: is,
  decor: sameDecor,
});

// Where the walk draws a placement: the palette its colours resolve from, and
// the region its decoration is dealt by.
interface Where {
  readonly palette: Palette;
  readonly region: Region;
}

export class ViewParts {
  // How many parts have derived since the view's first draw: what one draw
  // adds is how many of its parts it evaluated.
  evaluated = 0;
  // What the view's last drawn frame showed: the one thing a draw writes.
  readonly memory = new FrameMemory<RenderedLine>();
  // [LAW:one-source-of-truth] The view's one scope. Its names are the
  // store's when it is built, at the view's first draw: a view declares
  // every variable before it is drawn.
  readonly scope: object;
  readonly binding: RenderBinding;
  private readonly facts: DrawFacts;
  private readonly look = observable.box<RenderLook | undefined>(undefined, {
    deep: false,
    equals: (a, b) => a !== undefined && b !== undefined && sameLook(a, b),
  });
  private readonly layout: Derived<PreviewRows>;
  // [LAW:no-ambient-temporal-coupling] A globals rule is evaluated before the
  // draw resolves its look — the look is what the rules decide — so while one
  // is, the binding has neither look nor layout to give: a read is refused by
  // name (renderLook, renderLayout), never answered with the last draw's.
  // Read outside every kept part but the rule's own, which always runs here.
  private readonly phase = { ruling: false };
  private readonly gates = new Map<CompiledNode, Derived<Gate>>();
  private readonly placements = new Map<CompiledSegmentNode, Placement>();
  private readonly rules = new Map<Template<RichText>, Derived<RuleOutcome>>();

  constructor(
    private readonly store: VariableStore,
    readonly registry: Pick<SourceRegistry, "drawnAt">,
    readonly source: PartsSource,
    facts: DrawFacts,
  ) {
    this.scope = buildScope(store);
    const drawn = observable(facts, undefined, { deep: false });
    this.facts = drawn;
    const look = this.look;
    const phase = this.phase;
    const layout = (): PreviewRows => this.layout.read();
    this.binding = {
      store,
      registry,
      get width() {
        return drawn.width;
      },
      get chromeCols() {
        return drawn.chromeCols;
      },
      get padding() {
        return drawn.padding;
      },
      get seamCols() {
        return drawn.seamCols;
      },
      get look() {
        return phase.ruling ? undefined : look.get();
      },
      get layout() {
        return phase.ruling ? undefined : layout;
      },
    };
    this.layout = this.derive("layout", source.layoutReadsInstant, () => {
      // [LAW:no-defensive-null-guards] The draw resolves the preset to a
      // compiled one before it publishes it, and publishes its look before
      // the walk, the one place outside a rule the layout is read.
      const root = source.roots.get(drawn.preset)!;
      const palette = look.get()!.palette;
      return layoutRows(root, (node) => this.shown(node)).map((row) =>
        row.flatMap(({ name: placedName, address, settings }) => {
          const name = arrangedSegment(placedName);
          return name === undefined
            ? []
            : [
                {
                  name,
                  address,
                  palette: placementPalette(settings.theme, palette),
                },
              ];
        }),
      );
    });
  }

  // The draw's facts, before it reads a part.
  draw(facts: DrawFacts): void {
    this.draws++;
    runInAction(() => Object.assign(this.facts, facts));
  }

  // Which draw is in progress: a part that reads the instant answers once in it.
  private draws = 0;

  // The look the draw resolved, before its walk.
  publishLook(look: RenderLook): void {
    runInAction(() => this.look.set(look));
  }

  // A layout node's own `when`, as the walk asks it.
  gate(node: CompiledNode): Gate {
    const { when } = node;
    if (when === undefined) return gateOf(when, this.scope);
    let part = this.gates.get(node);
    if (part === undefined) {
      part = this.derive("when", this.readsInstant(when), () =>
        outsideSegments(this.source.activeSegment, () =>
          gateOf(when, this.scope),
        ),
      );
      this.gates.set(node, part);
    }
    return part.read();
  }

  placement(node: CompiledSegmentNode): PlacementParts {
    let parts = this.placements.get(node);
    if (parts === undefined) {
      parts = new Placement(this, node);
      this.placements.set(node, parts);
    }
    return parts;
  }

  rule(template: Template<RichText>): RuleOutcome {
    let part = this.rules.get(template);
    if (part === undefined) {
      part = this.derive(
        "rule",
        this.readsInstant(template),
        (): RuleOutcome => {
          this.phase.ruling = true;
          try {
            return {
              kind: "named",
              name: template
                .evaluate(this.scope)
                .map((f) => f.plain)
                .join(""),
            };
          } catch (e) {
            const pending = readPending(e);
            return pending !== undefined
              ? { kind: "pending", variable: pending.variable }
              : {
                  kind: "failed",
                  error: e instanceof Error ? e.message : String(e),
                };
          } finally {
            this.phase.ruling = false;
          }
        },
      );
      this.rules.set(template, part);
    }
    return part.read();
  }

  readsInstant(...templates: ReadonlyArray<Template<RichText> | undefined>) {
    return templates.some(
      (template) => template !== undefined && this.source.instant.has(template),
    );
  }

  // [LAW:single-enforcer] Every part derives here: kept by the store, or
  // derived at every read when it reads the instant, and counted.
  // A part that reads the instant is derived once per draw however often the
  // draw reads it — a body reads its colours, its lead and trail read both —
  // since one draw is one instant over one store.
  derive<T>(name: string, readsInstant: boolean, deriver: () => T): Derived<T> {
    const counted = (): T => {
      this.evaluated++;
      return deriver();
    };
    return this.store.derive(
      `part ${name}`,
      readsInstant ? "projection" : "computed",
      readsInstant ? this.oncePerDraw(counted) : counted,
    );
  }

  private oncePerDraw<T>(deriver: () => T): () => T {
    let memo: { readonly draw: number; readonly answer: Answer<T> } | null =
      null;
    return () => {
      if (memo?.draw !== this.draws) {
        memo = { draw: this.draws, answer: answerOf(deriver) };
      }
      return unwrap(memo.answer);
    };
  }

  // [LAW:one-source-of-truth] The walk's visibility less edit chrome, which
  // the rows a layout lays out are drawn by: a node's `when`, then a
  // segment's own — and a segment either `when` of which throws is SHOWN,
  // because the walk draws an error cell exactly there, where a container
  // whose `when` throws draws nothing. A `when` not answered yet is shown,
  // and under it a segment as its own `when` says, as the walk asks it. Edit
  // mode's `+`/`-` and reset banner are affordances over the arrangement, not
  // part of it, while a name label stands in for its segment
  // (`arrangedSegment`).
  private shown(node: CompiledNode): boolean {
    const gate = this.gate(node);
    if (node.kind === "container")
      return gate.kind === "shown" || gate.kind === "pending";
    if (arrangedSegment(node.name) === undefined) return false;
    if (gate.kind === "hidden") return false;
    if (gate.kind === "failed") return true;
    try {
      return this.placement(node).shown();
    } catch {
      return true;
    }
  }
}

// The view's parts for the compile `source` drawing from `store`, made at its
// first draw and kept in the compile's `views`.
export function viewParts(
  source: PartsSource & {
    readonly views: WeakMap<VariableStore, ViewParts>;
  },
  store: VariableStore,
  registry: Pick<SourceRegistry, "drawnAt">,
  facts: DrawFacts,
): ViewParts {
  let parts = source.views.get(store);
  if (parts === undefined) {
    parts = new ViewParts(store, registry, source, facts);
    source.views.set(store, parts);
  }
  return parts;
}

// One placement's parts in a view.
class Placement implements PlacementParts {
  // What the walk hands each part: where it draws the placement, then what
  // the colours and the body evaluated to.
  private readonly where = inlet(
    sameBy<Where>({ palette: is, region: sameRegion }),
  );
  private readonly ground = inlet(
    sameBy<{ colours: Dealt; bodyOpen: boolean }>({
      colours: sameDealt,
      bodyOpen: is,
    }),
  );
  private readonly opened = inlet(
    sameBy<{ colours: Dealt; open: boolean }>({
      colours: sameDealt,
      open: is,
    }),
  );
  private readonly gate: Derived<boolean>;
  private readonly open: Derived<boolean>;
  private readonly colours: Derived<Colours>;
  private readonly body: Derived<Body>;
  private readonly affixes: Derived<Affixes>;

  constructor(view: ViewParts, node: CompiledSegmentNode) {
    // [LAW:no-defensive-null-guards] cross-ref proved every placed segment is
    // declared, and the compile compiled every declared segment.
    const seg = view.source.segments[node.name]!;
    const ref = view.source.activeSegment;
    // [LAW:one-source-of-truth] Every template of THIS placement — its
    // segment's `when`, `bg:`, `fg:`, body, and edit mode's lead and trail —
    // reads this placement's settings; the gate of the body it hangs reads
    // the view's scope, as the body's own nodes do.
    const scope = placementScope(view.scope, node.settings);
    const { when, bg, fg, template } = seg;
    const { lead, trail } = node;
    const opens = node.opens?.open;
    this.gate =
      when === undefined
        ? always(true)
        : view.derive(`${node.id} when`, view.readsInstant(when), () =>
            outsideSegments(ref, () => evaluateWhen(when, scope)),
          );
    this.open =
      opens === undefined
        ? always(false)
        : view.derive(`${node.id} body gate`, view.readsInstant(opens), () =>
            outsideSegments(ref, () => evaluateWhen(opens, view.scope)),
          );
    this.colours = view.derive(
      `${node.id} colours`,
      view.readsInstant(bg, fg),
      () => {
        const { palette, region } = this.where.get();
        return coloursOf(
          ref,
          node,
          palette,
          region,
          view.registry.drawnAt(),
          bg,
          fg,
          scope,
        );
      },
    );
    this.body = view.derive(
      `${node.id} body`,
      view.readsInstant(template),
      () => {
        const { colours, bodyOpen } = this.ground.get();
        return bodyOf(ref, node, colours, template, bodyOpen, scope);
      },
    );
    this.affixes =
      lead === undefined && trail === undefined
        ? always(NO_AFFIXES)
        : view.derive(
            `${node.id} affixes`,
            view.readsInstant(lead, trail),
            () => {
              const { colours, open } = this.opened.get();
              return affixesOf(ref, node, colours, open, lead, trail, scope);
            },
          );
  }

  shown(): boolean {
    return this.gate.read();
  }

  bodyOpen(): boolean {
    return this.open.read();
  }

  // [LAW:dataflow-not-control-flow] The parts in their one order, each handed
  // what the one before it evaluated to: the colours, then the body over its
  // ground, then the lead and trail over what the body opened.
  evaluate(palette: Palette, region: Region): EvaluatedSegment {
    this.where.set({ palette, region });
    const colours = this.colours.read();
    this.ground.set({ colours, bodyOpen: this.open.read() });
    const body = this.body.read();
    this.opened.set({ colours, open: body.open });
    return evaluated(colours, body, this.affixes.read());
  }
}

// [LAW:no-ambient-temporal-coupling] What one part hands the next, through the
// walk: a box it fills with the value and the next part reads, compared by
// what that part reads of it — so a part kept across frames is not woken by a
// neighbour that is derived at every draw and answers alike, as it would be
// were it to read that neighbour itself. The walk fills each before the part
// reading it is read.
function inlet<T>(same: (a: T, b: T) => boolean) {
  const box = observable.box<T | undefined>(undefined, {
    deep: false,
    equals: (a, b) => a !== undefined && b !== undefined && same(a, b),
  });
  return {
    set: (value: T): void => runInAction(() => box.set(value)),
    // [LAW:no-defensive-null-guards] Filled before it is read (above).
    get: (): T => box.get()!,
  };
}

const sameHex = (a: ColorRgba, b: ColorRgba): boolean => a.hex === b.hex;

// Whether two colourings deal a body and its affixes alike: everything they
// can read of it — its record, its ground, and the band it opens.
const sameDealt = sameBy<Dealt>({
  palette: is,
  drawnAt: is,
  tint: sameHex,
  text: sameHex,
  bg: sameHex,
  disclosure: sameDisclosure,
});

// ─── What a placement's templates evaluate to ─────────────────────────────────

// The colours a placement's closed cell is drawn in: what its region dealt it
// in its palette at the depth drawn, and its `bg:`/`fg:` resolved over that.
interface Colours {
  readonly palette: Palette;
  readonly drawnAt: ColorDepth;
  readonly tint: ColorRgba;
  readonly text: ColorRgba;
  readonly disclosure: Disclosure;
  // The resolved background: the authored `bg:`, else the tint.
  readonly bg: ColorRgba;
  readonly style: Style;
}

// [LAW:types-are-the-program] What of its colours a placement's body and its
// lead and trail are handed: all but the closed cell's style, which the walk
// alone reads — so they read nothing `sameDealt` does not compare.
type Dealt = Omit<Colours, "style">;

interface Body {
  readonly fragments: readonly RichText[];
  readonly drops: readonly RichText[];
  // [LAW:one-source-of-truth] Open is the PRESENCE of something under the
  // segment: a dropped menu body, known only once the body has evaluated, or
  // an open disclosure body. The walk picks the cell's Style by this value.
  readonly open: boolean;
}

interface Affixes {
  readonly lead: readonly RichText[];
  readonly trail: readonly RichText[];
  readonly drops: readonly RichText[];
}

// The segment's record as its region deals it, its background `bg`.
function placeOf(
  node: CompiledSegmentNode,
  colours: Omit<Colours, "bg" | "style">,
) {
  return {
    segName: node.name,
    placementId: node.id,
    palette: colours.palette,
    disclosure: colours.disclosure,
    tint: colours.tint,
    text: colours.text,
  };
}

// The band the segment opens, read the one way for the background `{{ bgOf }}`
// sees, its shortfalls and every Style it can wear.
const bandOf = (colours: Dealt) =>
  bandFor(colours.palette, colours.disclosure, colours.drawnAt);

// [LAW:one-source-of-truth] What the segment is dealt is ONE `decorationFor`
// read of its region (src/themes/decor.ts): the tint its closed cell wears and
// the disclosure it opens, so the cell, the band it drops, and the body hung
// under it cannot disagree about their hue. Its `bg:` resolves first and its
// `fg:` may ask about it (resolveSegmentColors).
function coloursOf(
  ref: ActiveSegmentRef,
  node: CompiledSegmentNode,
  palette: Palette,
  region: Region,
  drawnAt: ColorDepth,
  bg: Template<RichText> | undefined,
  fg: Template<RichText> | undefined,
  scope: object,
): Colours {
  const dealt = {
    palette,
    drawnAt,
    ...decorationFor(palette, region, drawnAt),
  };
  return inSegment(ref, placeOf(node, dealt), (active) => {
    const style = resolveSegmentColors(active, drawnAt, bg, fg, scope);
    // [LAW:no-defensive-null-guards] resolveSegmentColors publishes the
    // background before it returns.
    return { ...dealt, bg: active.bg!, style };
  });
}

// `{{ bgOf }}` reads the ground the text is drawn on: an open segment wears its
// band's state colour, not its closed background. An open disclosure body is
// known before the body evaluates, so the body reads it too; a dropped menu is
// known only after, so the lead and trail — evaluated last — read the final
// ground either way. A band is read only where something hangs open under the
// segment: a band that can never be drawn throws when it is opened, never from
// a closed cell.
function bodyOf(
  ref: ActiveSegmentRef,
  node: CompiledSegmentNode,
  colours: Dealt,
  template: Template<RichText>,
  bodyOpen: boolean,
  scope: object,
): Body {
  return inSegment(ref, placeOf(node, colours), (active) => {
    active.bg = bodyOpen ? bandOf(colours).state : colours.bg;
    const fragments = template.evaluate(scope);
    return {
      fragments,
      drops: active.drops,
      open: active.drops.length > 0 || bodyOpen,
    };
  });
}

function affixesOf(
  ref: ActiveSegmentRef,
  node: CompiledSegmentNode,
  colours: Dealt,
  open: boolean,
  lead: Template<RichText> | undefined,
  trail: Template<RichText> | undefined,
  scope: object,
): Affixes {
  return inSegment(ref, placeOf(node, colours), (active) => {
    active.bg = open ? bandOf(colours).state : colours.bg;
    return {
      lead: lead?.evaluate(scope) ?? [],
      trail: trail?.evaluate(scope) ?? [],
      drops: active.drops,
    };
  });
}

const NO_AFFIXES: Affixes = { lead: [], trail: [], drops: [] };

function evaluated(
  colours: Colours,
  body: Body,
  affixes: Affixes,
): EvaluatedSegment {
  const { palette, drawnAt, disclosure } = colours;
  return {
    styles: {
      closed: colours.style,
      get trigger() {
        return stateCell(palette, bandOf(colours).state, drawnAt);
      },
      get band() {
        return stateCell(palette, bandOf(colours).plane, drawnAt);
      },
      get close() {
        return closeCell(palette, bandOf(colours).state, drawnAt);
      },
      disclosure,
    },
    fragments: body.fragments,
    lead: affixes.lead,
    trail: affixes.trail,
    drops: [...body.drops, ...affixes.drops],
    open: body.open,
    // [LAW:no-silent-failure] A floor the band stands short of is drawn as
    // near as it comes, and said so.
    shortfalls: body.open ? bandOf(colours).shortfalls : [],
  };
}

// A segment's templates evaluated once, kept nowhere: what a broken
// placement's edit buttons are drawn from.
export function evaluateOnce(
  ref: ActiveSegmentRef,
  node: CompiledSegmentNode,
  palette: Palette,
  region: Region,
  drawnAt: ColorDepth,
  body: Template<RichText>,
  scope: object,
): EvaluatedSegment {
  const colours = coloursOf(
    ref,
    node,
    palette,
    region,
    drawnAt,
    undefined,
    undefined,
    scope,
  );
  return evaluated(
    colours,
    bodyOf(ref, node, colours, body, false, scope),
    NO_AFFIXES,
  );
}

// The closed style a placement's region deals it in `palette`, its `bg:` and
// `fg:` unread: what a cell with no authored colours wears, and so what a
// placement whose value is not answered yet wears — a pending value states no
// meaning for a `bg:` to paint.
export function decoratedStyle(
  ref: ActiveSegmentRef,
  node: CompiledSegmentNode,
  palette: Palette,
  region: Region,
  drawnAt: ColorDepth,
): Style {
  return coloursOf(
    ref,
    node,
    palette,
    region,
    drawnAt,
    undefined,
    undefined,
    {},
  ).style;
}
