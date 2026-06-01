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

import { listResolvablePaletteNames, STYLE_ORDER } from "../../themes/policy";
import {
  enumerateOpenPaths,
  isOptionsButtonItem,
  isSubmenuItem,
} from "../../config/widget";
import type {
  ButtonItem,
  MenuTreeItem,
  OptionSource,
  WidgetDecl,
} from "../../config/widget";
import { walkNodes } from "../../config/dsl-types";
import type { DslConfig } from "../../config/dsl-types";

// [LAW:one-source-of-truth] One contribution shape — a (key, spec) pair — shared
// by both the widget walk and the node walk. mergeContributions folds a list of
// these into the final per-key validator specs, so widgets and nodes feed ONE
// coherence merge regardless of which surface authored the write.
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
  | { readonly kind: "range"; readonly min: number; readonly max: number };

// [LAW:one-source-of-truth] listResolvablePaletteNames is THE set whose
// members resolve to a concrete Palette. The broader listAvailableThemes
// includes the "custom" sentinel (read inline colors) which is not a
// renderable theme name; accepting "custom" here would persist an
// unrenderable value into SessionState and break the next render.
//
// [LAW:single-enforcer] Each validator's accepted-set is one constant
// lookup structure — a Set for O(1) `has` (matching the BOOLEAN_*
// validators below). The theme registry (rich-js THEMES) and STYLE_ORDER
// are module-init-static, so caching at module load is correct by
// construction; the (list, set) pair is built from the same source so
// the error-message ordering and the lookup membership cannot drift.
const RESOLVABLE_THEMES_LIST: readonly string[] = listResolvablePaletteNames();
const RESOLVABLE_THEMES: ReadonlySet<string> = new Set(RESOLVABLE_THEMES_LIST);
const RESOLVABLE_STYLES: ReadonlySet<string> = new Set(STYLE_ORDER);

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
      reason: `unknown style "${raw}" (have: ${STYLE_ORDER.join(", ")})`,
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

// [LAW:types-are-the-program] The validator is RESIDUE of the live specs: given
// the (uniform) kind and every live registration's content, the validator is
// forced. An int key builds a parse-boundary validator; an allow-list key builds
// one from the UNION of every live registration's members — so a value any live
// config can legitimately render is a value the wire accepts, by construction.
// The label is a pure function of (key, kind) so the built validator is identical
// across registrations of one key. makeIntValidator/makeAllowListValidator are
// the single validator constructors (re-validating slash/empty values), so a
// merged allow-list that somehow held an undeliverable value would throw HERE,
// at config-load, not at the operator's first click.
function buildValidatorFromSpecs(
  key: string,
  kind: DerivedValidatorSpec["kind"],
  specs: readonly DerivedValidatorSpec[],
): KeyValidator {
  if (kind === "int") return makeIntValidator(`menu page "${key}"`);
  if (kind === "range") {
    // [LAW:types-are-the-program] Two configs declaring one stepper key with
    // different bounds widen to the UNION range — parity with allow-list's
    // member union: a value any live config can legitimately render (step into)
    // is a value the wire accepts. The clamp is to the widest live bounds, so
    // the gate never rejects a write a narrower co-resident stepper could make.
    const mins = specs.flatMap((s) => (s.kind === "range" ? [s.min] : []));
    const maxs = specs.flatMap((s) => (s.kind === "range" ? [s.max] : []));
    return makeRangeValidator(
      Math.min(...mins),
      Math.max(...maxs),
      `stepper "${key}"`,
    );
  }
  const allowed = [
    ...new Set(
      specs.flatMap((s) => (s.kind === "allow-list" ? s.allowed : [])),
    ),
  ];
  return makeAllowListValidator(allowed, `state "${key}"`);
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
    existing.validator = buildValidatorFromSpecs(
      key,
      existing.kind,
      existing.specs,
    );
  } else {
    const specs = [spec];
    _STATE_VALIDATORS.set(key, {
      permanent: false,
      kind: spec.kind,
      validator: buildValidatorFromSpecs(key, spec.kind, specs),
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
      entry.validator = buildValidatorFromSpecs(key, entry.kind, entry.specs);
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

// [LAW:one-source-of-truth] The option members a picker draws from ARE the same
// canonical lists the `themes()`/`styles()` bindings and the baseline theme/
// style validators consult — the rendered options and the derived gate cannot
// diverge because there is no second enumeration.
function optionValuesFor(src: OptionSource): readonly string[] {
  return src === "themes" ? RESOLVABLE_THEMES_LIST : STYLE_ORDER;
}

// [LAW:single-enforcer] The ONE place mapping a widget kind to the validator
// key SPECS it declares. Every consumer reads these contributions; none re-walks a
// widget's shape by kind. A new widget kind is one new arm in this exhaustive
// switch, and the compiler forces it.
//   • a menu declares its page key as an INT spec (←/→/close navigation);
//   • a stepper declares its value key as a RANGE spec ([min,max]);
//   • both arms ALSO contribute their items' allow-list specs; buttons
//     contribute only those.
function widgetKeySpecs(w: WidgetDecl): ReadonlyArray<{
  readonly key: string;
  readonly spec: DerivedValidatorSpec;
}> {
  switch (w.kind) {
    case "stepper":
      return [
        { key: w.state, spec: { kind: "range", min: w.min, max: w.max } },
      ];
    case "menu":
      return [
        { key: w.state, spec: { kind: "int" } },
        ...itemKeySpecs(w.items),
      ];
    case "tree":
      // [LAW:one-source-of-truth] The open-path key's accepted set IS the tree's
      // enumerated paths — same data the renderer writes — plus every leaf's
      // allow-list spec (a tree's leaves are the SAME ButtonItem shape, so they
      // reuse itemKeySpecs once flattened out of the submenu structure).
      return [
        {
          key: w.state,
          spec: { kind: "allow-list", allowed: enumerateOpenPaths(w.items) },
        },
        ...itemKeySpecs(treeLeafItems(w.items)),
      ];
    case "buttons":
      return itemKeySpecs(w.items);
  }
}

// [LAW:dataflow-not-control-flow] Flatten a tree's clickable leaves out of its
// submenu nesting — a submenu contributes its descendants' leaves, a leaf is
// itself. The open/close behavior of submenus derives no validator (it writes
// the open-path key, handled above), so only leaves flow to itemKeySpecs.
function treeLeafItems(items: readonly MenuTreeItem[]): ButtonItem[] {
  return items.flatMap((item) =>
    isSubmenuItem(item) ? treeLeafItems(item.items) : [item],
  );
}

// [LAW:dataflow-not-control-flow] One allow-list spec per key an item `set`
// action writes. The allowed VALUES vary by item shape — an options item binds
// the whole resolved option list, a literal item writes its action's `to` — but
// that variability lives in the `optionValues` VALUE, not in a branch around
// different code: the same flatMap runs for every item.
function itemKeySpecs(
  items: readonly ButtonItem[],
): Array<{ readonly key: string; readonly spec: DerivedValidatorSpec }> {
  return items.flatMap((item) => {
    const optionValues = isOptionsButtonItem(item)
      ? optionValuesFor(item.optionsFrom)
      : null;
    return item.onClick.flatMap((action) =>
      "set" in action
        ? [
            {
              key: action.set,
              // [LAW:single-enforcer] The loader owns the literal⇒`to` pairing:
              // a fixed button's `set` carries a non-empty `to`; an options
              // button's never does (its values are the resolved option list).
              spec: {
                kind: "allow-list" as const,
                allowed:
                  optionValues ?? (action.to !== undefined ? [action.to] : []),
              },
            },
          ]
        : [],
    );
  });
}

// [LAW:types-are-the-program] Collapse one key's spec contributions into the
// single spec that gates it. A key is an INTEGER spec (a menu page `int` or a
// stepper `range`) or an allow-list — never both. An integer spec ABSORBS
// integer allow-list members (a button writing "0" to a menu page is a legal int
// write — the open-trigger pattern), and a NON-integer member aimed at it is the
// genuine contradiction that throws. Two ranges widen-union; two allow-lists
// union; an int and a range on one key (a menu page vs a stepper value) conflict.
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
      `deriveValidators: key "${key}" is an integer spec (a menu page ` +
        `index or a stepper value) but a click writes non-integer ` +
        `value(s) to it (${nonInt.join(", ")}). A state key has one key ` +
        `shape — point that click at a distinct key, or write an integer.`,
    );
  }
  if (hasInt && ranges.length > 0) {
    throw new Error(
      `deriveValidators: key "${key}" is declared as both a menu page ` +
        `(int) and a stepper value (range) — a state key has one key shape. ` +
        `Use distinct keys.`,
    );
  }
  if (ranges.length > 0) {
    const min = Math.min(...ranges.map((r) => r.min));
    const max = Math.max(...ranges.map((r) => r.max));
    // [LAW:no-silent-fallbacks] A menu page (int) is UNBOUNDED, so any integer
    // write is a legal member to absorb. A stepper range is BOUNDED — an integer
    // a click declares OUTSIDE [min,max] would be clamped by the range gate at
    // click time, silently storing a different value than the click rendered.
    // That is a config error, surfaced at load rather than papered over at click.
    const outOfRange = allowed.filter((v) => {
      const n = parseInt(v, 10);
      return n < min || n > max;
    });
    if (outOfRange.length > 0) {
      throw new Error(
        `deriveValidators: key "${key}" is a stepper range [${min},${max}] ` +
          `but a click writes out-of-range value(s) to it ` +
          `(${outOfRange.join(", ")}). The range gate would clamp them, storing a ` +
          `different value than the click renders — write an in-range integer, ` +
          `or point that click at a distinct key.`,
      );
    }
    return { kind: "range", min, max };
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

// [LAW:one-source-of-truth] The writable-key surface a config's WIDGETS need,
// DERIVED from the widget declarations (widgetKeySpecs) — the same data the
// renderer paginates/steps from and clicks against is the gate the wire enforces.
function widgetContributions(config: DslConfig): KeySpecContribution[] {
  return dropBaselineAllowLists(
    Object.values(config.widgets).flatMap(widgetKeySpecs),
  );
}

// [LAW:one-source-of-truth] The writable-key surface a config's LAYOUT NODES
// need, DERIVED by walking the node tree: each inline cell's `onClick` is a
// structured (key, value) write, so it contributes an allow-list spec whose lone
// member is that literal value. The same (key, value) the renderer turns into the
// click URL is the gate the wire enforces — the rendered click IS the gate.
function nodeContributions(config: DslConfig): KeySpecContribution[] {
  const out: KeySpecContribution[] = [];
  for (const node of walkNodes(config.root)) {
    if (node.kind !== "inline") continue;
    for (const cell of node.cells) {
      if (cell.onClick === undefined) continue;
      out.push({
        key: cell.onClick.set,
        spec: { kind: "allow-list", allowed: [cell.onClick.to] },
      });
    }
  }
  return dropBaselineAllowLists(out);
}

// [LAW:single-enforcer] THE coherence merge: group every contribution by key and
// collapse each key's specs into the one spec that gates it (mergeKeySpecs).
// Whether a contribution came from a widget or a node is irrelevant here — the
// open-trigger pattern (an inline cell writing "0" to a menu's int page key)
// resolves because mergeKeySpecs absorbs an integer allow-list member into the
// int spec. One merge, one gate per key.
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

// [LAW:one-source-of-truth] Per-surface derivations, each isolated-testable. The
// install site uses `deriveValidators` (both surfaces, one merge); these exist so
// each surface's contribution can be asserted on its own. deriveWidgetValidators
// keeps its exact prior contract (widgets only) — S5 deletes it once the widget
// surface is gone and deriveNodeValidators is the sole authority.
export function deriveWidgetValidators(
  config: DslConfig,
): readonly KeySpecContribution[] {
  return mergeContributions(widgetContributions(config));
}

export function deriveNodeValidators(
  config: DslConfig,
): readonly KeySpecContribution[] {
  return mergeContributions(nodeContributions(config));
}

// [LAW:single-enforcer] The install-site derivation: a config's writable-key
// surface is the merge of EVERY interaction declaration it carries — widget
// blocks AND layout-node onClicks — through ONE coherence pass. Registering the
// two surfaces separately would collide on a shared key (a menu's int page and a
// trigger cell's allow-list "0" are different KINDS to registerStateValidator);
// merging the contributions first lets mergeKeySpecs absorb the one into the
// other, so the daemon registers one consistent gate per key.
export function deriveValidators(
  config: DslConfig,
): readonly KeySpecContribution[] {
  return mergeContributions([
    ...widgetContributions(config),
    ...nodeContributions(config),
  ]);
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
