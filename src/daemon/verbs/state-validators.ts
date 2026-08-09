// [LAW:single-enforcer] One registry that names every SessionState key the
// `set-state` verb is allowed to write, paired with the per-key validator
// that decides whether a raw incoming string is a legal value for that key.
// Adding a new state-writable key is one entry in this table — no new verb,
// no scattered string-matching, no defensive guard in the dispatcher.
//
// [LAW:one-source-of-truth] The registered keys ARE the schema for what
// SessionState mutations the click protocol can perform. Tests assert
// against this table directly so the live schema and the test enumeration
// cannot drift. Unknown-key rejection lists these names — operators see
// exactly the surface they're allowed to write.
//
// [LAW:no-silent-fallbacks] An unknown key throws BAD_REQUEST at the
// dispatcher; never accept-and-store an unvalidated key. A typo on the
// wire surfaces as a structured rejection, not a silent corruption of
// SessionState.
//
// [LAW:types-are-the-program] The validator's return type is the program:
// the verb body cannot proceed without an `ok: true` branch and cannot
// fabricate a value — on failure it surfaces the reason verbatim. The
// SessionState value is currently string-typed, so the validator's
// `value` is the canonical string to write (post-normalization for boolean-
// ish keys). When a future widget needs a non-string typed value (e.g. a
// numeric stepper with int-range bounds), this same shape extends — the
// validator becomes the parsing boundary, the verb body the dataflow.

import { listResolvablePaletteNames, STRIP_STYLES } from "../../themes/policy";
import type { ActionDecl } from "../../config/action";
import {
  perConfigDomainsFor,
  resolveOptionDomain,
} from "../../config/option-domain";
import type { DslConfig } from "../../config/dsl-types";

// [LAW:one-source-of-truth] One contribution shape — a (key, spec) pair — every
// action's `set` declaration projects to. mergeContributions folds a list of
// these into the final per-key validator specs, so multiple actions writing one
// key feed ONE coherence merge regardless of which action authored the write.
interface KeySpecContribution {
  readonly key: string;
  readonly spec: DerivedValidatorSpec;
}

// [LAW:types-are-the-program] Discriminated union — every legal return is
// either an accepted-and-canonicalized string or a structured rejection
// reason. There is no third state (no `null`, no thrown exception path
// inside a validator). The verb body matches exhaustively on `ok`.
export type ValidateResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

// [LAW:one-type-per-behavior] All key validators have the same shape —
// they don't carry the key name, the registry does. The validator's only
// concern is: does this raw string belong in this key's value-set?
export type KeyValidator = (rawValue: string) => ValidateResult;

// [LAW:types-are-the-program] A derived key's SEMANTIC identity — the data a
// widget config declares about a custom SessionState key, from which the
// validator is residue. A key is one of three key shapes: an integer (a
// menu's page index), an allow-list (the union of values some button can write),
// or a bounded integer range (a stepper's value). The registry compares specs to
// decide whether two registrations can share a key (same `kind`) and merges them
// by unioning content (allow-list members; range bounds); the opaque
// `KeyValidator` it builds from the spec cannot be compared or merged, which is
// why registration takes the spec and owns validator construction.
//
// [LAW:one-source-of-truth] The spec carries only content (kind + allow-list
// members + range bounds), never the human label — the label is a pure function
// of the key, computed where the validator is built, so two registrations of one
// key yield byte-identical validators regardless of which config registered first.
export type DerivedValidatorSpec =
  | { readonly kind: "int" }
  | { readonly kind: "allow-list"; readonly allowed: readonly string[] }
  | {
      // [LAW:one-source-of-truth] A bounded-integer state key (a stepper's
      // value). `min`/`max` gate the value; `seed` is the value an UNSET key
      // reads as — sourced from the backing state variable's `default` so the
      // first relative click steps from the same number the bar displays (not
      // silently from `min`). The validator ignores `seed` (it only clamps); the
      // step-state handler reads it via rangeParamsFor when the key is unset.
      readonly kind: "range";
      readonly min: number;
      readonly max: number;
      readonly seed: number;
    };

// [LAW:one-source-of-truth] listResolvablePaletteNames is THE set whose
// members resolve to a concrete Palette. It deliberately excludes the "custom"
// sentinel (which needs inline colors and is not a renderable theme name):
// accepting "custom" here would persist an unrenderable value into SessionState
// and break the next render.
//
// [LAW:single-enforcer] Each validator's accepted-set is one constant
// lookup structure — a Set for O(1) `has` (matching the BOOLEAN_*
// validators below). The theme registry (rich-js THEMES) and STRIP_STYLES
// are module-init-static, so caching at module load is correct by
// construction; the (list, set) pair is built from the same source so
// the error-message ordering and the lookup membership cannot drift.
const RESOLVABLE_THEMES_LIST: readonly string[] = listResolvablePaletteNames();
const RESOLVABLE_THEMES: ReadonlySet<string> = new Set(RESOLVABLE_THEMES_LIST);
const RESOLVABLE_STYLES: ReadonlySet<string> = new Set(STRIP_STYLES);

const validateTheme: KeyValidator = (raw) => {
  if (!raw) return { ok: false, reason: "theme name is required" };
  if (!RESOLVABLE_THEMES.has(raw)) {
    return {
      ok: false,
      reason: `unknown theme "${raw}" (have: ${RESOLVABLE_THEMES_LIST.join(", ")})`,
    };
  }
  return { ok: true, value: raw };
};

const validateStyle: KeyValidator = (raw) => {
  if (!raw) return { ok: false, reason: "style name is required" };
  if (!RESOLVABLE_STYLES.has(raw)) {
    return {
      ok: false,
      reason: `unknown style "${raw}" (have: ${STRIP_STYLES.join(", ")})`,
    };
  }
  return { ok: true, value: raw };
};

// [LAW:dataflow-not-control-flow] Boolean-ish accepts exactly four
// canonical inputs and normalizes to two canonical outputs: truthy
// ("1"/"true") → "1", falsy ("0"/"false") → "" (empty). The empty
// falsy sentinel matches what `toolbar-toggle` produces via `clear()`
// for the next render — readers treat both as "off" because the DSL
// state binding's default fires on null/empty. Centralizing this
// canonical pair here means any future widget that writes a boolean
// state key gets the same on/off contract by registry row, not by
// re-deriving it inline.
//
// [LAW:no-silent-fallbacks] The empty string as INPUT is rejected, not
// silently mapped to falsy. An empty value on the wire is structurally
// ambiguous (did the operator mean "0", or did they forget to provide
// a value?); accepting it would be a silent semantic guess. Each of
// the comment, the accepted-input set, and the rejection message names
// the same four inputs — [LAW:one-source-of-truth] kept by construction
// instead of by maintenance.
const BOOLEAN_TRUTHY = new Set(["1", "true"]);
const BOOLEAN_FALSY = new Set(["0", "false"]);
const validateBoolean: KeyValidator = (raw) => {
  if (BOOLEAN_TRUTHY.has(raw)) return { ok: true, value: "1" };
  if (BOOLEAN_FALSY.has(raw)) return { ok: true, value: "" };
  return {
    ok: false,
    reason: `expected boolean-ish (1, 0, true, false), got "${raw}"`,
  };
};

// [LAW:types-are-the-program] Two registry-entry shapes, discriminated by
// `permanent`. A baseline entry is a fixed built-in validator (theme/style/
// toolbar-expanded) that can never be removed or re-claimed. A derived entry
// holds the LIVE registrations for a widget-installed key: each registration
// contributes a spec, the entry's `validator` is rebuilt as their merge, and
// `specs.length` IS the ref-count. The same derived key legitimately registers
// more than once — multiple cache entries share one config (one repo, two
// cwds), and a hot-reload builds the new state's validators BEFORE disposing the
// old (so the key is briefly held twice). The merged validator stays valid
// across the whole overlap; the key is removed only when the last spec disposes.
interface BaselineEntry {
  readonly permanent: true;
  readonly validator: KeyValidator;
}
interface DerivedEntry {
  readonly permanent: false;
  // [LAW:types-are-the-program] All live specs for a key share one kind — the
  // registration check rejects a kind change, so `kind` is the entry's stable
  // key shape and the discriminator the rebuild matches on.
  readonly kind: DerivedValidatorSpec["kind"];
  validator: KeyValidator;
  // [LAW:one-source-of-truth] The live registrations. The validator is derived
  // from these (union of allow-list members); they are the single source, the
  // validator the cache. `length` is the ref-count — no separate counter to drift.
  readonly specs: DerivedValidatorSpec[];
}
type ValidatorEntry = BaselineEntry | DerivedEntry;

// [LAW:one-source-of-truth] THE registry of state keys the click protocol can
// write. Baseline keys are permanent; widget-derived keys carry their live
// registrations.
//
// [LAW:types-are-the-program] A `Map` lookup is `(key) → entry | undefined` with
// NO prototype chain — `__proto__`/`constructor` from an untrusted wire URL are
// ordinary non-members, not truthy hits on Object.prototype. A plain object
// would admit those as truthy lookups that crash on invocation (RENDER_FAILED
// instead of the intended BAD_REQUEST). Map makes that unrepresentable.
const _STATE_VALIDATORS = new Map<string, ValidatorEntry>([
  ["style", { validator: validateStyle, permanent: true }],
  ["theme", { validator: validateTheme, permanent: true }],
  ["toolbar-expanded", { validator: validateBoolean, permanent: true }],
]);

// [LAW:dataflow-not-control-flow] listStateKeys returns a fresh snapshot on each
// call — the snapshot semantics IS the contract. A frozen constant would
// silently misreport the writable surface after a widget config registered a key.
export function listStateKeys(): readonly string[] {
  return [..._STATE_VALIDATORS.keys()];
}

// [LAW:types-are-the-program] The validator is RESIDUE of a SETTLED spec: given
// one merged spec, its validator is forced. This is a pure projection — kind ⇒
// constructor — with NO union or widen of its own. The label is a pure function
// of (key, kind) so the built validator is identical across registrations of one
// key. makeIntValidator/makeRangeValidator/makeAllowListValidator are the single
// validator constructors (re-validating slash/empty values), so a merged spec
// that somehow held an undeliverable value would throw HERE, at config-load, not
// at the operator's first click.
function validatorForSpec(
  key: string,
  spec: DerivedValidatorSpec,
): KeyValidator {
  if (spec.kind === "int") return makeIntValidator(`menu page "${key}"`);
  if (spec.kind === "range")
    return makeRangeValidator(spec.min, spec.max, `stepper "${key}"`);
  return makeAllowListValidator(spec.allowed, `state "${key}"`);
}

// [LAW:one-source-of-truth] The validator for a key's live registrations, built
// through the ONE collapse: mergeKeySpecs unions allow-list members, widens range
// bounds, clamps the seed, and absorbs integer members — so the union/widen logic
// lives in exactly one place and this builder is pure plumbing (collapse → project).
// A value any live config can legitimately render is a value the wire accepts, by
// construction, because the rendered options and the derived gate read one merge.
function buildValidatorFromSpecs(
  key: string,
  specs: readonly DerivedValidatorSpec[],
): KeyValidator {
  return validatorForSpec(key, mergeKeySpecs(key, specs));
}

// [LAW:locality-or-seam] The widget config (a config-load consumer) owns the
// lifecycle of the validators it installs; this returns a disposer rather than
// coupling the registry to a global "config reload" event. The cache's
// reloadInto installs the new state's validators, then disposes the old — the
// dispose-before-swap contract that keeps a broken reload from corrupting
// last-known-good. See src/daemon/cache/render.ts.
//
// [LAW:no-silent-fallbacks] A baseline (permanent) key cannot be re-claimed —
// re-registering one throws, so a menu naming its page key `theme` surfaces a
// loud config-load error rather than silently shadowing the theme gate.
//
// [LAW:types-are-the-program] The semantic-compatibility gate: a key has ONE
// key shape. Registering an `int` spec for a key already held as `allow-list`
// (or vice versa) is a genuine conflict — no merged validator could honor both —
// so it throws at config-load, not silently keeps whichever loaded first. Two
// registrations of the SAME kind merge: their specs accumulate and the validator
// is rebuilt as their union, so two cache entries sharing a config (identical
// specs → idempotent) and two distinct configs sharing a key (different members
// → unioned, both deliverable) both resolve to one consistent gate.
//
// [LAW:single-enforcer] The disposer removes exactly its own spec once
// (idempotent via the `active` flag), rebuilds the validator from what remains,
// and deletes the key only when the last spec is gone.
export function registerStateValidator(
  key: string,
  spec: DerivedValidatorSpec,
): () => void {
  if (!key) {
    throw new Error("registerStateValidator: key is required");
  }
  // [LAW:types-are-the-program] The set-state wire splits its tail on `/`, so a
  // slash-bearing key can never be addressed — listing it would be registry-vs-
  // wire drift. Reject at registration so the unreachable-but-listed state is
  // unrepresentable.
  if (key.includes("/")) {
    throw new Error(
      `registerStateValidator: key "${key}" contains "/" — the set-state ` +
        `wire shape splits on "/" so a slash-bearing key cannot be ` +
        `addressed. Use a slash-free key.`,
    );
  }
  const existing = _STATE_VALIDATORS.get(key);
  if (existing) {
    if (existing.permanent) {
      throw new Error(
        `registerStateValidator: key "${key}" is a built-in state key and ` +
          `cannot be re-claimed (built-in keys: ${[...baselineKeys()].join(", ")})`,
      );
    }
    if (existing.kind !== spec.kind) {
      throw new Error(
        `registerStateValidator: key "${key}" is already a ${existing.kind} ` +
          `state key; cannot also register it as ${spec.kind}. A state key has ` +
          `one key shape — a menu page index (int) and a button allow-list ` +
          `cannot share a key.`,
      );
    }
    existing.specs.push(spec);
    existing.validator = buildValidatorFromSpecs(key, existing.specs);
  } else {
    const specs = [spec];
    _STATE_VALIDATORS.set(key, {
      permanent: false,
      kind: spec.kind,
      validator: buildValidatorFromSpecs(key, specs),
      specs,
    });
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const entry = _STATE_VALIDATORS.get(key);
    if (!entry || entry.permanent) return;
    const i = entry.specs.indexOf(spec);
    if (i >= 0) entry.specs.splice(i, 1);
    if (entry.specs.length === 0) {
      _STATE_VALIDATORS.delete(key);
    } else {
      entry.validator = buildValidatorFromSpecs(key, entry.specs);
    }
  };
}

function baselineKeys(): readonly string[] {
  const out: string[] = [];
  for (const [key, entry] of _STATE_VALIDATORS) {
    if (entry.permanent) out.push(key);
  }
  return out;
}

// [LAW:one-type-per-behavior] The "values come from list Y" pattern IS
// the canonical widget-config use case (theme picker draws from
// themes(), style picker draws from styles(), a custom enum picker
// draws from a user-declared list). One factory builds the validator
// from the list — every callsite that registers an allow-list key
// passes through the same shape, so error messages, empty-input
// rejection, and lookup semantics are identical by construction.
//
// [LAW:no-silent-fallbacks] Empty input is rejected with a label-
// referencing reason rather than silently mapped to a default — the
// shape matches validateTheme/validateStyle so the operator experience
// is consistent across baseline and widget-installed keys.
export function makeAllowListValidator(
  allowed: readonly string[],
  label: string,
): KeyValidator {
  // [LAW:types-are-the-program] The factory's contract is "options =
  // allow list" — every value the picker can RENDER must also be a
  // value the wire can DELIVER. Two structural reasons a declared
  // option can't reach the validator as itself:
  //   (1) the wire splits the tail on "/", so a slash-bearing value
  //       would arrive as two segments — the validator never sees it
  //       as one value;
  //   (2) the validator's empty-input rejection ("X value is required")
  //       fires before the allow-list check, so an "" in the allow
  //       list would be listed-but-undeliverable.
  // Both are the same shape as [LAW:registry-vs-wire drift] caught by
  // registerStateValidator's slash-key check. Catching at factory-build
  // time (config-load) per [LAW:verifiable-goals] surfaces a
  // misconfigured option list immediately, not on the operator's first
  // click. Mirrors registry surface = writable surface, by construction.
  const slashOffenders = allowed.filter((v) => v.includes("/"));
  if (slashOffenders.length > 0) {
    throw new Error(
      `makeAllowListValidator(${label}): values contain "/" — the set-state ` +
        `wire shape splits values on "/" so slash-bearing options cannot ` +
        `be addressed. Offending values: ${slashOffenders.join(", ")}`,
    );
  }
  if (allowed.includes("")) {
    throw new Error(
      `makeAllowListValidator(${label}): empty string is not a writable ` +
        `option — the validator rejects empty input before the allow-list ` +
        `check, so an "" in the allowed list could be rendered but never ` +
        `delivered. Remove "" from the allowed list.`,
    );
  }
  const allowedSet: ReadonlySet<string> = new Set(allowed);
  const allowedList = [...allowed];
  return (raw) => {
    if (!raw) return { ok: false, reason: `${label} value is required` };
    if (!allowedSet.has(raw)) {
      return {
        ok: false,
        reason: `unknown ${label} "${raw}" (have: ${allowedList.join(", ")})`,
      };
    }
    return { ok: true, value: raw };
  };
}

// [LAW:types-are-the-program] An integer-valued state key (a menu's page
// index). The wire delivers a string; the validator IS the parse boundary —
// it accepts only `^-?\d+$` and canonicalizes to the minimal decimal form, so
// "007"/"-0" can't persist a non-canonical page that the next render's `int`
// read would have to re-normalize. Negative is legal: -1 is the menu's CLOSED
// sentinel.
const INT_RE = /^-?\d+$/;
export function makeIntValidator(label: string): KeyValidator {
  return (raw) => {
    if (!raw) return { ok: false, reason: `${label} value is required` };
    if (!INT_RE.test(raw)) {
      return { ok: false, reason: `${label} must be an integer, got "${raw}"` };
    }
    // [LAW:types-are-the-program] Canonicalize as a pure decimal string —
    // strip leading zeros, fold "-0" → "0" — NOT via parseInt/String, which for
    // a >= 1e21 magnitude would emit scientific notation ("1e+21") that a later
    // parseInt(_, 10) reads back as 1. A page index is small in practice, but
    // the canonical form must hold for every accepted input, not just small ones.
    const neg = raw[0] === "-";
    const digits = (neg ? raw.slice(1) : raw).replace(/^0+/, "");
    if (digits === "") return { ok: true, value: "0" };
    return { ok: true, value: neg ? `-${digits}` : digits };
  };
}

// [LAW:types-are-the-program] A bounded-integer state key (a stepper's value).
// The validator is the parse-AND-clamp boundary: it accepts only `^-?\d+$` then
// clamps into [min,max]. [LAW:single-enforcer] This is the ONE place bounds are
// enforced — it owns the [min,max] floor/ceiling for EVERY write to the key,
// including a hand-typed wire URL. The stepper render owns NAVIGATION (wrap past
// a bound to the other end) the way the menu render owns page navigation; the
// stepper only ever emits values already inside bounds, so for stepper clicks
// this clamp is identity. The clamped result is small (≤ |max| or |min| digits),
// so String() cannot emit the scientific notation the raw int canonicalizer
// guards against.
export function makeRangeValidator(
  min: number,
  max: number,
  label: string,
): KeyValidator {
  return (raw) => {
    if (!raw) return { ok: false, reason: `${label} value is required` };
    if (!INT_RE.test(raw)) {
      return { ok: false, reason: `${label} must be an integer, got "${raw}"` };
    }
    const clamped = Math.max(min, Math.min(max, parseInt(raw, 10)));
    return { ok: true, value: String(clamped) };
  };
}

// [LAW:types-are-the-program] Collapse one key's spec contributions into the
// single spec that gates it. A key is an INTEGER spec (a paged cursor `int` or a
// bounded `range`) or an allow-list — never both. An integer spec ABSORBS
// integer allow-list members (a trigger writing "0" to a page cursor is a legal
// int write — the open-trigger pattern), and a NON-integer member aimed at it is
// the genuine contradiction that throws. Two ranges widen-union; two allow-lists
// union; an int and a range on one key (a page cursor vs a bounded value) conflict.
function mergeKeySpecs(
  key: string,
  specs: readonly DerivedValidatorSpec[],
): DerivedValidatorSpec {
  type Range = Extract<DerivedValidatorSpec, { kind: "range" }>;
  const ranges = specs.filter((s): s is Range => s.kind === "range");
  const hasInt = specs.some((s) => s.kind === "int");
  const allowed = specs.flatMap((s) =>
    s.kind === "allow-list" ? s.allowed : [],
  );
  if (ranges.length === 0 && !hasInt) {
    return { kind: "allow-list", allowed: [...new Set(allowed)] };
  }
  // [LAW:no-silent-fallbacks] An integer spec accepts only integer writes; a
  // non-integer member is a one-key-shape contradiction surfaced at load.
  const nonInt = allowed.filter((v) => !INT_RE.test(v));
  if (nonInt.length > 0) {
    throw new Error(
      `deriveActionValidators: key "${key}" is an integer spec (a paged ` +
        `cursor or a bounded value) but a click writes non-integer ` +
        `value(s) to it (${nonInt.join(", ")}). A state key has one key ` +
        `shape — point that click at a distinct key, or write an integer.`,
    );
  }
  if (hasInt && ranges.length > 0) {
    throw new Error(
      `deriveActionValidators: key "${key}" is declared as both a paged ` +
        `cursor (int) and a bounded value (range) — a state key has one key ` +
        `shape. Use distinct keys.`,
    );
  }
  if (ranges.length > 0) {
    const min = Math.min(...ranges.map((r) => r.min));
    const max = Math.max(...ranges.map((r) => r.max));
    // [LAW:no-silent-fallbacks] A page cursor (int) is UNBOUNDED, so any integer
    // write is a legal member to absorb. A bounded range is BOUNDED — an integer
    // a click declares OUTSIDE [min,max] would be clamped by the range gate at
    // click time, silently storing a different value than the click rendered.
    // That is a config error, surfaced at load rather than papered over at click.
    const outOfRange = allowed.filter((v) => {
      const n = parseInt(v, 10);
      return n < min || n > max;
    });
    if (outOfRange.length > 0) {
      throw new Error(
        `deriveActionValidators: key "${key}" is a bounded range [${min},${max}] ` +
          `but a click writes out-of-range value(s) to it ` +
          `(${outOfRange.join(", ")}). The range gate would clamp them, storing a ` +
          `different value than the click renders — write an in-range integer, ` +
          `or point that click at a distinct key.`,
      );
    }
    // [LAW:one-source-of-truth] Every range contribution to a key carries the
    // same seed (the one backing state variable's default), so any is canonical;
    // re-clamp it into the widened [min,max] to stay an in-range start value.
    const seed = clampSeed(ranges[0]!.seed, min, max);
    return { kind: "range", min, max, seed };
  }
  return { kind: "int" };
}

// [LAW:single-enforcer] A STRUCTURAL spec (menu int / stepper range) is always
// kept — even on a baseline key — so a collision throws loudly at registration
// rather than silently shadowing the permanent gate. Only an ALLOW-LIST
// contribution to a baseline key is dropped (the click reuses the baseline gate
// as intended). The spec kind IS that discriminator: structural is int/range, an
// item/onClick spec is allow-list. Shared by both contribution collectors.
function dropBaselineAllowLists(
  contributions: readonly KeySpecContribution[],
): KeySpecContribution[] {
  const baseline = new Set(baselineKeys());
  return contributions.filter(
    (c) => c.spec.kind !== "allow-list" || !baseline.has(c.key),
  );
}

// [LAW:single-enforcer] THE coherence merge: group every contribution by key and
// collapse each key's specs into the one spec that gates it (mergeKeySpecs).
// Multiple actions writing the same key (a picker's int page and a trigger's
// literal "0" are different KINDS to registerStateValidator) resolve here because
// mergeKeySpecs absorbs an integer allow-list member into the int spec. One
// merge, one gate per key.
function mergeContributions(
  contributions: readonly KeySpecContribution[],
): KeySpecContribution[] {
  const byKey = new Map<string, DerivedValidatorSpec[]>();
  for (const { key, spec } of contributions) {
    const specs = byKey.get(key);
    if (specs) specs.push(spec);
    else byKey.set(key, [spec]);
  }
  return [...byKey].map(([key, specs]) => ({
    key,
    spec: mergeKeySpecs(key, specs),
  }));
}

// [LAW:single-enforcer] The ONE place mapping a decoupled ACTION to the validator
// key SPEC it declares. The discriminator is the action's value SOURCE (which key
// is present), as DATA:
//   • a literal `set` + `to` declares an allow-list of {to};
//   • an option `set` + `from` declares an allow-list of the resolved domain —
//     the SAME canonical list the picker iterates, so the rendered options and
//     the gate cannot diverge;
//   • a bounded `set` + `min/max/by` declares a range [min,max] (the stepper's
//     navigation owns the wrap; the gate owns the bounds — `by` is render-only,
//     never in the spec) plus a `seed` (the unset initial value, read from the
//     backing state variable's `default` so the first relative click steps from
//     the displayed number);
//   • an `int` `set` declares an unbounded int (a paged picker's page cursor —
//     the renderer owns clamping; the gate requires integer shape);
//   • a `cycle` `set` declares an allow-list of its members (the renderer only
//     ever writes the successor member);
//   • copy/open write nothing, so they declare no spec.
// A new action arm is one new branch here, returning data the existing merge
// folds — no consumer re-walks an action's shape.
function actionKeySpecs(
  a: ActionDecl,
  seeds: ReadonlyMap<string, number>,
  perConfigDomains: ReadonlyMap<string, readonly string[]>,
): KeySpecContribution[] {
  if (!("set" in a)) return [];
  if ("to" in a) {
    return [{ key: a.set, spec: { kind: "allow-list", allowed: [a.to] } }];
  }
  if ("from" in a) {
    return [
      {
        key: a.set,
        spec: {
          kind: "allow-list",
          allowed: resolveOptionDomain(a.from, perConfigDomains),
        },
      },
    ];
  }
  // [LAW:single-enforcer] An int cursor (a paged picker's page key) gates as an
  // unbounded int — the SAME `int` spec a menu page used. The renderer owns
  // clamping to valid pages; the gate only requires integer shape.
  if ("int" in a) {
    return [{ key: a.set, spec: { kind: "int" } }];
  }
  // [LAW:one-source-of-truth] A cycle's members ARE its gate: the renderer only
  // ever writes a member (the successor of the current value), and the
  // allow-list admits exactly the members. Sharing groups' cycles on one key
  // union here like any other allow-list contributions — that union IS the
  // accordion's writable path set.
  if ("cycle" in a) {
    return [{ key: a.set, spec: { kind: "allow-list", allowed: a.cycle } }];
  }
  return [
    {
      key: a.set,
      spec: {
        kind: "range",
        min: a.min,
        max: a.max,
        seed: clampSeed(seeds.get(a.set), a.min, a.max),
      },
    },
  ];
}

// [LAW:one-source-of-truth] The unset seed for a stepped key is the backing
// state variable's `default` — the SAME number the bar displays before the first
// click — so the first relative step doesn't silently start from `min`. Absent or
// non-integer default falls back to `min` (the historical render-side behavior).
function clampSeed(seed: number | undefined, min: number, max: number): number {
  if (seed === undefined) return min;
  return Math.max(min, Math.min(max, seed));
}

// [LAW:one-source-of-truth] Each `state` variable's integer `default` is the
// initial value of its key — the value the bar renders before any click. The
// step-state handler must seed an unset key from the SAME number, so the derived
// range spec carries it. A non-integer or absent default contributes nothing
// (the key seeds from `min`).
function stateKeySeeds(config: DslConfig): ReadonlyMap<string, number> {
  const seeds = new Map<string, number>();
  for (const decl of Object.values(config.variables)) {
    if (decl.kind !== "state") continue;
    const raw = decl.default;
    if (raw !== undefined && INT_RE.test(raw)) {
      seeds.set(decl.key, parseInt(raw, 10));
    }
  }
  return seeds;
}

// [LAW:one-source-of-truth] The writable-key surface a config's ACTIONS need,
// DERIVED from the action table — the same declarations the `{{ action }}` fn
// realizes a click from are the gate the wire enforces.
function actionContributions(config: DslConfig): KeySpecContribution[] {
  const seeds = stateKeySeeds(config);
  const perConfigDomains = perConfigDomainsFor(config.looks);
  return dropBaselineAllowLists(
    Object.values(config.actions).flatMap((a) =>
      actionKeySpecs(a, seeds, perConfigDomains),
    ),
  );
}

// [LAW:single-enforcer] The SOLE install-site derivation: a config's writable-key
// surface is the merge of every ACTION it declares, through ONE coherence pass.
// The action table is the single interaction authority — the same declarations
// the `{{ action }}`/`{{ picker }}` funcs realize clicks from are the gate the
// wire enforces. mergeContributions resolves any intra-table key collision (a
// picker's int page and a trigger's literal "0" on one key) into one gate.
export function deriveActionValidators(
  config: DslConfig,
): readonly KeySpecContribution[] {
  return mergeContributions(actionContributions(config));
}

// [LAW:dataflow-not-control-flow] Single entry point for validation: the
// caller hands over (key, value), this returns a uniform ValidateResult
// regardless of whether the key was known. The verb body never branches
// on "did I get a validator" — the absence of a validator IS the rejection.
export function validateStateWrite(
  key: string,
  rawValue: string,
): ValidateResult {
  const entry = _STATE_VALIDATORS.get(key);
  if (!entry) {
    return {
      ok: false,
      reason: `unknown state key "${key}" (have: ${listStateKeys().join(", ")})`,
    };
  }
  return entry.validator(rawValue);
}

// [LAW:types-are-the-program] The bounded-step parameters of a key: the (widened)
// [min,max] the step wraps within plus the `seed` an unset key starts from. The
// step-state handler reads these to compute `wrap(current ± by)` against LIVE
// state — the link carries only the signed `by`, so every numeric the wrap needs
// lives here in the single registry, never snapshotted into the link.
export interface RangeParams {
  readonly min: number;
  readonly max: number;
  readonly seed: number;
}

// [LAW:one-source-of-truth] The registry IS the source of a key's bounds; the
// step handler reads them through this one boundary rather than re-deriving from
// the config. A key with no range registration (unknown, baseline, allow-list,
// or int) returns null — the handler rejects it as "not a stepper" loudly,
// never silently treating it as a step target.
export function rangeParamsFor(key: string): RangeParams | null {
  const entry = _STATE_VALIDATORS.get(key);
  if (!entry || entry.permanent || entry.kind !== "range") return null;
  // [LAW:one-source-of-truth] The bounds/seed come from THE same collapse the
  // validator is built from (mergeKeySpecs) — no second widen/clamp lives here.
  const spec = mergeKeySpecs(key, entry.specs);
  // [LAW:no-silent-failure] entry.kind === "range" means every live spec is a
  // range (registration rejects a kind change), so the collapse is a range too;
  // a non-range here is a broken invariant, surfaced loudly, not a silent null.
  if (spec.kind !== "range") {
    throw new Error(
      `rangeParamsFor: key "${key}" holds range specs but the merge produced ` +
        `a ${spec.kind} spec — the entry-kind invariant is broken.`,
    );
  }
  return { min: spec.min, max: spec.max, seed: spec.seed };
}
