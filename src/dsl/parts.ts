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

import { observable, runInAction, type IObservableValue } from "mobx";
import type {
  ColorDepth,
  ColorRgba,
  Palette,
  RichText,
  Style,
} from "@promptctl/rich-js";
import type { Template } from "@promptctl/go-template-js";
import type { Derived, VariableStore } from "../var-system/store.js";
import { resolvePath, type SourceRegistry } from "../var-system/sources.js";
import { buildScope, placementScope } from "../template-engine/scope.js";
import { is, sameBy } from "../utils/same.js";
import { gateOf, resolveSegmentColors } from "../template-engine/index.js";
import { HIDDEN, SHOWN, type Gate } from "../template-engine/layout.js";
import {
  inSegment,
  outsideSegments,
  type ActiveSegmentRef,
} from "../render/active-segment.js";
import {
  bindRender,
  type ActionRuntime,
  type PreviewRows,
  type RenderBinding,
  type RenderLook,
} from "../render/action.js";
import { closeCell, stateCell } from "../render/band-style.js";
import { arrangedSegment } from "../config/edit-chrome.js";
import { placementPalette } from "../themes/index.js";
import {
  decideEffectName,
  decideStyleName,
  drawnDepth,
  isColorCompatibility,
  ruleFloorMessage,
  SLOT_FLOORS,
  type ColorCompatibility,
  type ExpressionSlot,
} from "../themes/policy.js";
import { decideThemeName } from "../themes/palette-resolvers.js";
import type { ThemeKey } from "@promptctl/rich-js";
import { drawProjectionAt, slotAt } from "../config/payload-inputs.js";
import { CONFIG_KEY_TO_EFFECTIVE_VAR } from "../config/setting-projections.js";
import type { Selections, ViewSource } from "./view-source.js";
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
  type SegmentStyles,
} from "./node-registry.js";
import { FrameMemory } from "../render/frame-memory.js";
import { readPending } from "../var-system/types.js";

// A globals rule as the compile parsed it: the paths it was written at, and
// its template.
export interface CompiledRule {
  readonly where: string;
  readonly template: Template<RichText>;
}

// What of a compile its parts are evaluated from.
export interface PartsSource {
  readonly segments: CompiledSegments;
  readonly roots: ReadonlyMap<string, CompiledNode>;
  readonly activeSegment: ActiveSegmentRef;
  // The templates that read the instant, and whether the layout does.
  readonly instant: ReadonlySet<Template<RichText>>;
  readonly layoutReadsInstant: boolean;
  // Each slot's rules, by source, and the styles a style rule may name.
  readonly globalExpressions: ReadonlyMap<
    ExpressionSlot,
    ReadonlyMap<string, CompiledRule>
  >;
  readonly styles: Readonly<Record<string, ThemeKey>>;
  // The runtime the compile's template functions read the render through.
  readonly runtime: ActionRuntime;
}

// [LAW:types-are-the-program] What a selection slot holds in a view: the
// name it settled on — a decided name, or the answer of a rule that reads no
// instant, kept until what it read changes — with the `rule` warning a
// failure carries and the variable a pending answer waits on; or a rule that
// reads the instant, which each draw evaluates (`per-draw`).
export type SlotState =
  | {
      readonly kind: "settled";
      readonly name: string;
      readonly warning: string | null;
      readonly waited: string | null;
    }
  | { readonly kind: "per-draw"; readonly rule: CompiledRule };

// The selection each slot reads.
const SELECTION_OF: Readonly<Record<ExpressionSlot, keyof Selections>> = {
  palette: "theme",
  style: "style",
  effect: "effect",
};

// Where the depth every contrast floor reads is set.
const COLOR_PATH = CONFIG_KEY_TO_EFFECTIVE_VAR.get("colorCompatibility")!;
const COLOR_FLOOR: ColorCompatibility = "truecolor";

// What a view's parts read of the draw before its first: nothing a part may
// read outside a draw, so any value serves.
const UNDRAWN: DrawFacts = {
  width: 0,
  chromeCols: 0,
  padding: 0,
  seamCols: 0,
  preset: "",
};

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
  private readonly slots = new Map<ExpressionSlot, Derived<SlotState>>();
  // [LAW:one-source-of-truth] What the view draws from (`bind`): its inputs
  // and its slots read it as it stands, never a copy a draw wrote.
  private readonly view: IObservableValue<ViewSource>;
  // The draw in progress's own facts — the payload fields its instant answers
  // (DRAW_PROJECTIONS) — and the names its per-draw rules settled on: read by
  // the projections over them, which only a draw reads.
  private projected: unknown = undefined;
  private readonly drawnSlots = new Map<ExpressionSlot, string>();

  constructor(
    private readonly store: VariableStore,
    readonly registry: SourceRegistry,
    readonly source: PartsSource,
    view: ViewSource,
  ) {
    this.view = observable.box(view, { deep: false });
    this.scope = buildScope(store);
    // [LAW:one-source-of-truth] The depth the view draws at: kept over its
    // payload's `colorCompatibility.effective`, so a part measuring a floor
    // moves when the setting does — edit mode's staged depth included — and
    // never when a source is rebound with the same one.
    this.depth = store.derive("drawn depth", "computed", () => {
      const said = this.inputAt(COLOR_PATH);
      return typeof said === "string" && isColorCompatibility(said)
        ? said
        : COLOR_FLOOR;
    });
    const drawn = observable(UNDRAWN, undefined, { deep: false });
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
    // [LAW:single-enforcer] The registry's inputs, and its depth, are derived
    // through the view's one source. [LAW:no-ambient-temporal-coupling] Bound
    // last: binding reruns, in its action, every cache policy already declared
    // over an input, and one reaching a rule reads this view's binding.
    registry.bindInputs({
      read: (path) => this.inputAt(path),
      drawnAt: () => drawnDepth(this.colorCompatibility()),
    });
  }

  // What the view draws from: a session view's source is bound once; a caller
  // drawing a fixed payload binds each.
  bind(view: ViewSource): void {
    runInAction(() => this.view.set(view));
  }

  // The selections in force.
  selections(): Selections {
    return this.view.get().selections();
  }

  // The draw's facts, before it reads a part, and the payload fields its own
  // instant answers.
  draw(facts: DrawFacts, projected: unknown): void {
    this.draws++;
    this.projected = projected;
    this.drawnSlots.clear();
    runInAction(() => Object.assign(this.facts, facts));
  }

  // [LAW:dataflow-not-control-flow] The value at a payload path, by who
  // answers it: a selection's `.effective` its slot, a field of the instant
  // the draw in progress, every other the view's payload.
  private inputAt(path: string): unknown {
    const slot = slotAt(path);
    if (slot !== undefined) return this.slotName(slot);
    if (drawProjectionAt(path) !== undefined)
      return resolvePath(this.projected, path);
    return resolvePath(this.view.get().payload(), path);
  }

  // The depth the view's colour setting draws at: its floor while the payload
  // has not said, or says something no depth is.
  private readonly depth: Derived<ColorCompatibility>;
  colorCompatibility(): ColorCompatibility {
    return this.depth.read();
  }

  // [LAW:one-source-of-truth] A selection slot's node: the decided name, or
  // the rule's answer. A rule that reads no instant is kept: settled in the
  // turn what it reads changes, so a cache policy over the slot's
  // `.effective` re-runs then, never at a draw. A pending answer keeps the
  // name last settled (the floor before any); a failure is the floor with
  // its warning, which every draw reading the slot reports.
  slot(slot: ExpressionSlot): SlotState {
    let node = this.slots.get(slot);
    if (node === undefined) {
      let last: string | undefined;
      const settle = (): SlotState => {
        const selection = this.selections()[SELECTION_OF[slot]];
        if (selection.kind === "decided")
          return settled(selection.name, null, null);
        const rule = compiledRule(this.source, slot, selection.source);
        if (this.source.instant.has(rule.template))
          return { kind: "per-draw", rule };
        const outcome = this.rule(rule.template);
        switch (outcome.kind) {
          case "named": {
            let warning: string | null = null;
            last = decideSlot(
              this.source,
              slot,
              outcome.name,
              rule.where,
              (m) => {
                warning = m;
              },
            );
            return settled(last, warning, null);
          }
          case "pending":
            return settled(last ?? SLOT_FLOORS[slot], null, outcome.variable);
          case "failed":
            // A failure settles on the floor, so a pending answer after it
            // keeps the floor, as a per-draw rule's frame does.
            last = SLOT_FLOORS[slot];
            return settled(
              last,
              ruleFloorMessage(
                rule.where,
                slot,
                `the rule failed — ${outcome.error}`,
              ),
              null,
            );
        }
      };
      // [LAW:one-source-of-truth] A state equal to the one held IS that one:
      // a source rebound with the same selections (a fixed payload drawn
      // again) moves no reader of the slot.
      let held: SlotState | undefined;
      node = this.store.derive(`slot ${slot}`, "computed", (): SlotState => {
        const next = settle();
        if (held === undefined || !sameSlot(held, next)) held = next;
        return held;
      });
      this.slots.set(slot, node);
    }
    return node.read();
  }

  // The name a slot's `.effective` reads: its settled name, or what this
  // draw's rule settled on.
  slotName(slot: ExpressionSlot): string {
    const state = this.slot(slot);
    return state.kind === "settled"
      ? state.name
      : (this.drawnSlots.get(slot) ?? SLOT_FLOORS[slot]);
  }

  // What a per-draw rule settled on in the draw in progress.
  drawnSlot(slot: ExpressionSlot, name: string): void {
    this.drawnSlots.set(slot, name);
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
          // [LAW:no-ambient-temporal-coupling] A kept rule settles outside any
          // draw, in the turn what it read changes: the compile's functions
          // read this view's binding there too, as they do in its draw. Inside
          // its own draw the binding is already its own; while another view's
          // draw holds the compile, binding throws, by name.
          const bound =
            this.source.runtime.bound === this.binding
              ? null
              : bindRender(this.source.runtime, this.binding);
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
            bound?.[Symbol.dispose]();
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
    return this.placement(node).gate().kind !== "hidden";
  }
}

type ViewsOf = PartsSource & {
  readonly views: WeakMap<VariableStore, ViewParts>;
};

// [LAW:single-enforcer] The one way a store becomes a view of the compile
// `source`: its parts are made at its first bind, after every variable is
// declared, and kept in the compile's `views`; each bind names what the view
// draws from.
export function bindView(
  source: ViewsOf,
  store: VariableStore,
  registry: SourceRegistry,
  view: ViewSource,
): ViewParts {
  const parts = source.views.get(store);
  if (parts !== undefined) {
    parts.bind(view);
    return parts;
  }
  const made = new ViewParts(store, registry, source, view);
  source.views.set(store, made);
  return made;
}

// The view's parts for a store a source was bound to.
// [LAW:no-silent-failure] A store drawn before anything said what it draws
// from has no inputs to read: a caller bug, named.
export function partsOf(source: ViewsOf, store: VariableStore): ViewParts {
  const parts = source.views.get(store);
  if (parts === undefined) {
    throw new Error(
      "a store was drawn before its view was bound (bindView): its inputs have no source",
    );
  }
  return parts;
}

const settled = (
  name: string,
  warning: string | null,
  waited: string | null,
): SlotState => ({ kind: "settled", name, warning, waited });

const sameSlot = (a: SlotState, b: SlotState): boolean =>
  a.kind === "settled"
    ? b.kind === "settled" &&
      a.name === b.name &&
      a.warning === b.warning &&
      a.waited === b.waited
    : b.kind === "per-draw" && a.rule === b.rule;

// [LAW:no-defensive-null-guards] The compile parses every rule the resolution
// can hand a view; a miss is drift between the two readers of `isExpression`.
export function compiledRule(
  source: Pick<PartsSource, "globalExpressions">,
  slot: ExpressionSlot,
  rule: string,
): CompiledRule {
  const compiled = source.globalExpressions.get(slot)?.get(rule);
  if (compiled === undefined) {
    throw new Error(
      `the ${slot} rule ${JSON.stringify(rule)} reached the view but no compiled ` +
        `template exists — the compile and the resolution disagree about isExpression`,
    );
  }
  return compiled;
}

// [LAW:one-type-per-behavior] The name a rule wrote, decided in its slot's
// domain: a theme naming nothing installed is the floor, reported; a style or
// an effect naming nothing declared collapses to its floor in silence, its
// floor being the identity.
export function decideSlot(
  source: Pick<PartsSource, "styles">,
  slot: ExpressionSlot,
  name: string,
  where: string,
  warn: (message: string) => void,
): string {
  switch (slot) {
    case "palette":
      return decideThemeName(name, where, warn).name;
    case "style":
      return decideStyleName(name, source.styles).name;
    case "effect":
      return decideEffectName(name).name;
  }
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
  private readonly ownGate: Derived<Gate>;
  private readonly open: Derived<Gate>;
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
    this.ownGate =
      when === undefined
        ? always<Gate>(SHOWN)
        : view.derive(`${node.id} when`, view.readsInstant(when), () =>
            outsideSegments(ref, () => gateOf(when, scope)),
          );
    this.open =
      opens === undefined
        ? always<Gate>(HIDDEN)
        : view.derive(`${node.id} body gate`, view.readsInstant(opens), () =>
            outsideSegments(ref, () => gateOf(opens, view.scope)),
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

  gate(): Gate {
    return this.ownGate.read();
  }

  bodyGate(): Gate {
    return this.open.read();
  }

  // [LAW:dataflow-not-control-flow] The parts in their one order, each handed
  // what the one before it evaluated to: the colours, then the body over its
  // ground, then the lead and trail over what the body opened.
  evaluate(palette: Palette, region: Region): EvaluatedSegment {
    this.where.set({ palette, region });
    const colours = this.colours.read();
    this.ground.set({ colours, bodyOpen: this.open.read().kind === "shown" });
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
// sees and every Style it can wear.
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
// segment.
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

// Every Style a placement coloured `colours` can wear. A band is read only
// where one is worn, so a closed cell pays nothing for one.
function stylesOf(colours: Colours): SegmentStyles {
  const { palette, drawnAt, disclosure } = colours;
  return {
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
  };
}

function evaluated(
  colours: Colours,
  body: Body,
  affixes: Affixes,
): EvaluatedSegment {
  return {
    styles: stylesOf(colours),
    fragments: body.fragments,
    lead: affixes.lead,
    trail: affixes.trail,
    drops: [...body.drops, ...affixes.drops],
    open: body.open,
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

// The styles a placement's region deals it in `palette`, its `bg:` and `fg:`
// unread: what a cell with no authored colours wears, and so what a placement
// whose value is not answered yet wears — a pending value states no meaning for
// a `bg:` to paint — closed, or as the trigger of the body it hangs open.
export function decoratedStyles(
  ref: ActiveSegmentRef,
  node: CompiledSegmentNode,
  palette: Palette,
  region: Region,
  drawnAt: ColorDepth,
): SegmentStyles {
  return stylesOf(
    coloursOf(ref, node, palette, region, drawnAt, undefined, undefined, {}),
  );
}
