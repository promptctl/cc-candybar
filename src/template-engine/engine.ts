// [LAW:one-source-of-truth] One Engine instance covers all segment template
// evaluation. Callers parse their template once (engine.parse(src)) and call
// template.evaluate(scope) per render — the expensive parse step is not
// repeated per render cycle.
//
// Function registry (closed set for cc-candybar):
//  • Go builtins (always registered by the engine): printf, print, println,
//    eq/ne/lt/gt/le/ge, and/or/not, len, index, slice, call.
//  • sprigDefaults: default, empty, coalesce, ternary, fromJson, toJson.
//  • sprigStrings: trunc, lower, upper, replace, trim/trimPrefix/trimSuffix,
//    split/join, contains, hasPrefix, hasSuffix, and more string utils.
//  • sprigLists: has (membership test: `has "v" $list`).
//  • sprigMath: add, sub, mul, div, mod, floor, ceil, round, min, max,
//    seq, until (round here is shadowed by formatterFuncs' Math.round below).
//  • sprigDatetime: now and ago read the engine's clock (a clock factory);
//    date, dateInZone, dateModify, toDate, duration, unixEpoch, … are
//    functions of their arguments alone.
//  • sprigConversions: atoi, int, int64, float64, toString, toStrings
//    (int here is shadowed by ccCandybarFuncs' var-system cast below).
//  • sprigDicts: dict, get, set, keys, values, pick, omit, hasKey, merge —
//    `dict` lets a helper take multiple named inputs through its one dot arg.
//  • richTextFuncs: fg, bg, bold, italic, link, style (painting) PLUS the
//    palette-free color math (darken, lighten, mix, contrastOn, readableOn,
//    shiftHue, scaleChroma, scaleLightness, shiftLightness) — all from rich-js.
//    Naming a THEME color (`{{ color "primary" }}`, `{{ ramp … }}` over palette
//    names) and asking for the current segment's background (`{{ bgOf }}`)
//    are segment-scoped, so they arrive through `extraFuncs` from the DSL
//    render layer, which is the only place that knows which segment is rendering.
//  • animationFuncs: frames, stepped — the frame and the colour in progress
//    at the draw's animation clock (rich-js), and realtimeFrames/realtimeStepped
//    at its instant: clock factories.
//  • ccCandybarFuncs: basename, dirname, int, string, bool, urlEncode,
//    themes, endcaps, sparkline.
//  • relativeTimeFuncs: minutesUntilReset, etaMinutes — a clock factory.
//  • formatterFuncs: formatInteger, round, formatModelName, shortenModelName.
//    (The cost/token/
//    budget AND duration/time-remaining formatters moved to DSL helper templates
//    — see DEFAULT_DSL_CONFIG.helpers.)

import {
  createEngine,
  type Engine,
  type FuncMap,
  sprigDefaults,
  sprigStrings,
  sprigLists,
  sprigMath,
  sprigDatetime,
  sprigConversions,
  sprigFlow,
  sprigDicts,
} from "@promptctl/go-template-js";
import { RichText, type ColorDepth, type Timeline } from "@promptctl/rich-js";
import { _isComputingDerivation } from "mobx";
import {
  animationFuncs,
  readableOnFunc,
  richTextFuncs,
  type DrawnAt,
  type TemplateFrame,
} from "@promptctl/rich-js/template-bindings";
import { ccCandybarFuncs, formatterFuncs, relativeTimeFuncs } from "./funcs.js";
import type { Clock, ClockFactory } from "./clock.js";
import { dateOf, type Instant } from "../utils/instant.js";

// [LAW:no-shared-mutable-globals] The draw in progress: the one record every
// clock function reads, owned here and written only by `bindClock`, which binds
// it for a draw's synchronous walk and unbinds it on every exit (`using`, a
// throw included). Process-wide because a draw is: JS draws one frame at a
// time, and both engines (a registry's and a compile's) read the frame being
// drawn. A read with no draw bound is a read outside any frame, and throws
// [LAW:no-silent-failure] — only a projection reads the clock, and only a draw
// evaluates one (brandon-unfiled-3248.8ro6, step 6).
interface Drawing {
  readonly at: Instant;
  readonly timeline: Timeline;
  readonly frame: TemplateFrame;
  // The soonest moment, on the host clock, at which a hold an animation
  // function told the frame ends.
  soonest: number;
}
let drawing: Drawing | null = null;

// A draw's bound clock: released when the draw ends, and asked, once its walk
// is done, the soonest moment a hold told to it ends — Infinity when none was.
export interface BoundClock extends Disposable {
  heard(): number;
}

// [LAW:no-ambient-temporal-coupling] The instant and the session's animation
// timeline of the draw about to walk, for exactly as long as the returned
// handle is held. Draws do not nest: a second bind while one is held would hand
// the inner draw's instant to the outer's remaining reads, so it is refused.
// [LAW:one-source-of-truth] rich-js's `stepped`, `tween` and `loop` draw no
// cells, so the frame they are evaluated for is the only place they say when
// what they drew changes (`TemplateFrame.onHold`); the binding keeps that, and
// the frame's own hold is its cells' and this one's together (src/dsl/render.ts).
export function bindClock(at: Instant, timeline: Timeline): BoundClock {
  if (drawing !== null) {
    throw new Error("a draw is already in progress: draws do not nest");
  }
  const bound: Drawing = {
    at,
    timeline,
    frame: {
      time: at,
      onHold: ({ nextChange }) => {
        bound.soonest = Math.min(bound.soonest, nextChange);
      },
    },
    soonest: Infinity,
  };
  drawing = bound;
  return {
    heard: () => bound.soonest,
    [Symbol.dispose]: () => {
      drawing = null;
    },
  };
}

// [LAW:single-enforcer] Every projection ends in a read here, so this is
// where a value that keeps its answer is refused the instant: a computed or a
// reaction tracking when the clock is read would hold this draw's instant
// until something else it reads changes. The load's fold makes a projection of
// every template that names the instant (projections.ts); this catches one
// reaching it by a name it does not spell (`index . "clock"`).
// [LAW:single-enforcer] exception: MobX's `_isComputingDerivation` is reached
// here and nowhere else; it is true exactly while a derivation tracks.
function drawInProgress(read: string): Drawing {
  // A value that keeps its answer is refused first, drawn or not: its fix is
  // its template, whenever it is first read.
  if (_isComputingDerivation()) {
    throw new Error(
      `the clock was read by a value that keeps its answer (${read}): a template reaching a time variable or a clock function by a name it does not spell (index, get) is not known to read the instant — name it: {{ .clock }}`,
    );
  }
  if (drawing === null) {
    throw new Error(`the clock was read outside a draw (${read})`);
  }
  return drawing;
}

// [LAW:types-are-the-program] The one Clock. No module exports it: a function
// reads it only by being built by a ClockFactory the engine invokes, so a
// function passed in `extraFuncs` cannot capture a clock — none is in reach.
const CLOCK: Clock = {
  now: () => dateOf(drawInProgress("now").at),
  frame: () => drawInProgress("frame").frame,
  timeline: () => drawInProgress("timeline").timeline,
};

// rich-js's `frames` and `stepped`, the animation functions the bar's
// templates draw with, evaluated for the draw's frame and run through
// `timeline` — the host clock itself when none is given. `tween`, `loop` and
// `glyphs` are not registered, so a template naming one is refused as an
// unknown function. Every one of them says when what it drew changes on the
// host clock: `frames` and `glyphs` on the cells they stamp, the rest to the
// frame's `onHold` (`bindClock`).
function animationPair(
  frame: () => TemplateFrame,
  timeline?: () => Timeline,
): FuncMap {
  const { frames, stepped } = animationFuncs(
    frame,
    timeline === undefined ? {} : { timeline },
  );
  // [LAW:no-silent-failure] A rich-js that drops either is a vocabulary the
  // bundled bar's templates no longer load against.
  if (frames === undefined || stepped === undefined) {
    throw new Error(
      "rich-js's animationFuncs no longer registers frames and stepped",
    );
  }
  return { frames, stepped };
}

// The engine's own clock factories. `frames`/`stepped` are decoration, so they
// run through the session's animation timeline, at its speed;
// `realtimeFrames`/`realtimeStepped` are the same pair on the host clock, for a
// readout of real time — the lane toggles' spinner, which shows frames arriving
// at 30 a second and would read frozen at 20x (brandon-menus-sjhy.nt2)
// [LAW:one-type-per-behavior].
// sprig's datetime vocabulary bundles functions of their arguments with the
// two that read its clock; only those two are clock functions. The rest are
// built over a clock that refuses, so a release of sprig that reads the clock
// in another is a loud error rather than a projection nobody knows of
// [LAW:no-silent-failure].
const SPRIG_CLOCK_READERS = new Set(["now", "ago"]);

function sprigDatetimeWhere(clock: () => Date, readsClock: boolean): FuncMap {
  return Object.fromEntries(
    Object.entries(sprigDatetime(clock)).filter(
      ([name]) => SPRIG_CLOCK_READERS.has(name) === readsClock,
    ),
  );
}

const SPRIG_DATE_FUNCS = sprigDatetimeWhere(() => {
  throw new Error(
    "a sprig date function other than now and ago read the clock: add it to SPRIG_CLOCK_READERS",
  );
}, false);

const CLOCK_FACTORIES: readonly ClockFactory[] = [
  (clock) => sprigDatetimeWhere(clock.now, true),
  (clock) => animationPair(clock.frame, clock.timeline),
  (clock) =>
    Object.fromEntries(
      Object.entries(animationPair(clock.frame)).map(([name, func]) => [
        `realtime${name.replace(/^./, (c) => c.toUpperCase())}`,
        func,
      ]),
    ),
  relativeTimeFuncs,
];

function clockFuncs(factories: readonly ClockFactory[]): FuncMap {
  return Object.assign({}, ...factories.map((factory) => factory(CLOCK)));
}

// [LAW:one-source-of-truth] The clock functions: the names the engine's own
// clock factories return, recorded by invoking them, never a written list. A
// template calling one is a projection, and a cache key calling one is refused
// at load (src/config/loader/projections.ts). A compile's engine adds the
// render's own clock factories (the swatch row's `?`) to its instance; only a
// segment's templates can call those.
export const CLOCK_FUNCTIONS: ReadonlySet<string> = new Set(
  Object.keys(clockFuncs(CLOCK_FACTORIES)),
);

// The clock functions of an engine built with `extra` clock factories beside
// its own — a compile's, whose segment templates can call the swatch row's.
export function engineClockFunctions(
  extra: readonly ClockFactory[],
): ReadonlySet<string> {
  return new Set([...CLOCK_FUNCTIONS, ...Object.keys(clockFuncs(extra))]);
}

// [LAW:one-source-of-truth] The functions that read the drawn depth: rich-js's
// one DrawnAt-reading binding, registered from this table over richTextFuncs'
// own, so the names the scope fold reads (a cache key calling one reads a
// session's value — src/dsl/variable-scope.ts) are the names the engine binds.
const DEPTH_BINDINGS = { readableOn: readableOnFunc } as const;
export const DEPTH_FUNCTIONS: ReadonlySet<string> = new Set(
  Object.keys(DEPTH_BINDINGS),
);

// [LAW:single-enforcer] fromString/toString are declared once here.
// richTextFuncs() provides the theme-independent vocabulary: painting, color
// math, attributes, links. It needs no configuration, so it is unconditional.
// [LAW:one-way-deps] `extraFuncs` is an INJECTED FuncMap (e.g. the action +
// picker feature funcs, built in render/action.ts + render/picker.ts), and
// `clockFuncs` the injected clock factories (the swatch row's). The generic
// engine never imports a specific feature — the caller hands it the capability
// as data, so the dependency runs caller → engine, never engine → feature.
// `drawnAt` is the depth `readableOn` floors text at: the registry's, derived
// from its view's colour setting (SourceRegistry.drawnAt). Required, so no engine floors at a
// depth nobody stated. It carries no terminal: the detached daemon cannot see
// the client's.
export function createCcCandybarEngine(opts: {
  readonly drawnAt: () => ColorDepth;
  readonly extraFuncs?: FuncMap;
  readonly clockFuncs?: readonly ClockFactory[];
}): Engine<RichText> {
  const { drawnAt, extraFuncs } = opts;
  const depth = (): DrawnAt => ({ depth: drawnAt() });
  return createEngine<RichText>({
    fromString: (s) => new RichText(s),
    toString: (rt) => rt.plain,
    // A bare document in a template (`{{ .doc }}` for `{{ .doc.field }}`)
    // prints as Go prints a map, instead of leaking the object into the
    // fragments as if it were text.
    isT: (v): v is RichText => v instanceof RichText,
    // [LAW:no-defensive-null-guards] missing fields must throw at the boundary,
    // not silently produce "<no value>". Callers (SourceRegistry, segments)
    // depend on MissingFieldError to drive varDefault / defaultEmptyValue.
    missingKey: "error",
    funcs: {
      ...sprigDefaults(),
      ...sprigStrings(),
      ...sprigLists(),
      ...sprigMath(),
      ...sprigConversions(),
      // `fail` is how a stand-in for a dropped plugin's helper says why.
      ...sprigFlow(),
      // [LAW:types-are-the-program] `dict` is the substrate primitive a helper
      // uses to receive more than one input through its single dot arg:
      // `{{ template "budgetStatus" (dict "cost" .x "budget" .y "warn" .z) }}`.
      // It makes a multi-input formatter's domain exactly {named scalars},
      // decoupled from any payload's nesting — no per-payload helper variant.
      ...sprigDicts(),
      ...SPRIG_DATE_FUNCS,
      ...richTextFuncs(depth),
      ...Object.fromEntries(
        Object.entries(DEPTH_BINDINGS).map(([name, bind]) => [
          name,
          bind(depth),
        ]),
      ),
      // [LAW:single-enforcer] Every function that reads the time, built over
      // the one Clock.
      ...clockFuncs([...CLOCK_FACTORIES, ...(opts.clockFuncs ?? [])]),
      // Domain-specific overrides last (wins on collision with sprig aliases).
      // [LAW:one-source-of-truth] ccCandybarFuncs' `int` is the var-system cast
      // (toNumber over VarValue); it intentionally shadows sprigConversions' `int`
      // so a template's `int` keeps one meaning. Position is the override policy.
      ...ccCandybarFuncs(),
      // [LAW:one-source-of-truth] formatter funcs delegate to
      // src/utils/formatters.ts. The only sprig collision is `round`:
      // formatterFuncs' Math.round shadows sprigMath's precision-aware round,
      // registered last so the domain meaning wins (revisited by the bdi
      // cleanup ticket).
      ...formatterFuncs(),
      // [LAW:locality-or-seam] Injected feature funcs (the daemon's per-config
      // engine supplies the `action` + `picker` funcs; resolver-less compile-only
      // paths do not). Last so a feature can override on collision.
      ...(extraFuncs ?? {}),
    },
  });
}
