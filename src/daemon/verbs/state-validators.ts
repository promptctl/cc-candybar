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
// SessionState column is currently string-typed, so the validator's
// `value` is the canonical string to write (post-normalization for boolean-
// ish keys). When a future widget needs a non-string typed value (e.g. a
// numeric stepper with int-range bounds), this same shape extends — the
// validator becomes the parsing boundary, the verb body the dataflow.

import { listResolvablePaletteNames, STYLE_ORDER } from "../../themes/policy";
import type { DslConfig, OptionSource } from "../../config/dsl-types";
import { isMenuWidget, isOptionsButtonItem } from "../../config/dsl-types";

// [LAW:types-are-the-program] Discriminated union — every legal return is
// either an accepted-and-canonicalized string or a structured rejection
// reason. There is no third state (no `null`, no thrown exception path
// inside a validator). The verb body matches exhaustively on `ok`.
export type ValidateResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

// [LAW:one-type-per-behavior] All key validators have the same shape —
// they don't carry the key name, the registry does. The validator's only
// concern is: does this raw string belong in this key's column?
export type KeyValidator = (rawValue: string) => ValidateResult;

// [LAW:types-are-the-program] A derived key's SEMANTIC identity — the data a
// widget config declares about a custom SessionState key, from which the
// validator is residue. A key is one of exactly two column shapes: an integer
// (a menu's page index) or an allow-list (the union of values some button can
// write). The registry compares specs to decide whether two registrations can
// share a key (same `kind`) and merges them by unioning content; the opaque
// `KeyValidator` it builds from the spec cannot be compared or merged, which is
// why registration takes the spec and owns validator construction.
//
// [LAW:one-source-of-truth] The spec carries only content (kind + allow-list
// members), never the human label — the label is a pure function of the key,
// computed where the validator is built, so two registrations of one key yield
// byte-identical validators regardless of which config registered first.
export type DerivedValidatorSpec =
  | { readonly kind: "int" }
  | { readonly kind: "allow-list"; readonly allowed: readonly string[] };

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
  // column shape and the discriminator the rebuild matches on.
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
// column shape. Registering an `int` spec for a key already held as `allow-list`
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
          `one column shape — a menu page index (int) and a button allow-list ` +
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

// [LAW:one-source-of-truth] The option members a picker draws from ARE the same
// canonical lists the `themes()`/`styles()` bindings and the baseline theme/
// style validators consult — the rendered options and the derived gate cannot
// diverge because there is no second enumeration.
function optionValuesFor(src: OptionSource): readonly string[] {
  return src === "themes" ? RESOLVABLE_THEMES_LIST : STYLE_ORDER;
}

// [LAW:one-source-of-truth] The writable-key surface a config's widgets need is
// DERIVED from the widget declarations — the same data the renderer paginates
// from and clicks against is the gate the wire enforces, so they cannot diverge.
// Two column shapes fall out of the declarations:
//   • a menu's `state` page key is INTEGER-valued (←/→ navigation + apply-and-
//     close to -1);
//   • a button's `set` action writes an ALLOW-LIST key whose members are every
//     value that button can produce — the literal `to` for a fixed button, or
//     the resolved option list for an `optionsFrom` picker. Multiple buttons (or
//     items) writing one key union into one allow-list: the gate accepts exactly
//     what the config can render.
//
// [LAW:single-enforcer] Baseline keys (theme/style/toolbar-expanded) already own
// a permanent validator, so a button writing `set: theme` is using the canonical
// theme gate as intended — it derives NOTHING (skipped). A menu PAGE key is not
// skipped: naming it `theme` collides with the baseline at registration and
// throws, because an integer page index genuinely cannot share the theme column.
// The asymmetry is the real semantic difference — a button reuses a baseline
// gate; a menu page key conflicts with it.
//
// [LAW:no-silent-fallbacks] A within-config key that is BOTH a menu page (int)
// and a button target (allow-list) is a contradiction no single column can
// honor — it throws at derivation (config-load), not silently picks one shape.
export function deriveWidgetValidators(config: DslConfig): ReadonlyArray<{
  readonly key: string;
  readonly spec: DerivedValidatorSpec;
}> {
  const baseline = new Set(baselineKeys());
  const intKeys = new Set<string>();
  const allowListMembers = new Map<string, Set<string>>();
  const addMembers = (key: string, values: readonly string[]): void => {
    if (baseline.has(key)) return;
    let set = allowListMembers.get(key);
    if (!set) {
      set = new Set<string>();
      allowListMembers.set(key, set);
    }
    for (const v of values) set.add(v);
  };

  for (const widget of Object.values(config.widgets)) {
    if (isMenuWidget(widget)) intKeys.add(widget.state);
    for (const item of widget.items) {
      if (isOptionsButtonItem(item)) {
        const values = optionValuesFor(item.optionsFrom);
        for (const action of item.onClick) {
          if ("set" in action) addMembers(action.set, values);
        }
      } else {
        for (const action of item.onClick) {
          // [LAW:single-enforcer] The loader owns the literal⇒`to` pairing: a
          // fixed button's `set` action always carries a non-empty, slash-free
          // `to` (an options button's never does). Reading `to` here narrows the
          // deliberately-optional field to the literal value it guarantees.
          if ("set" in action && action.to !== undefined) {
            addMembers(action.set, [action.to]);
          }
        }
      }
    }
  }

  for (const key of intKeys) {
    if (allowListMembers.has(key)) {
      throw new Error(
        `deriveWidgetValidators: key "${key}" is written both as a menu page ` +
          `index (int) and a button allow-list value — a state key has one ` +
          `column shape. Give the menu page key a distinct name.`,
      );
    }
  }

  return [
    ...[...intKeys].map((key) => ({
      key,
      spec: { kind: "int" as const },
    })),
    ...[...allowListMembers].map(([key, members]) => ({
      key,
      spec: { kind: "allow-list" as const, allowed: [...members] },
    })),
  ];
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
