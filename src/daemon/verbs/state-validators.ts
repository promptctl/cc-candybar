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
import type { DslConfig } from "../../config/dsl-types";
import { isMenuWidget } from "../../config/dsl-types";

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

// [LAW:types-are-the-program] One registry entry. `permanent` marks the
// built-in keys (theme/style/toolbar-expanded) that can never be removed or
// re-claimed; `refCount` tracks how many live cache entries installed a derived
// key. The same derived key legitimately registers more than once — multiple
// cache entries share one config (one repo, two cwds), and a hot-reload builds
// the new state's validators BEFORE disposing the old (so the key is briefly
// held twice). Ref-counting keeps the key valid across the whole overlap and
// removes it only when the last holder disposes.
interface ValidatorEntry {
  readonly validator: KeyValidator;
  readonly permanent: boolean;
  refCount: number;
}

// [LAW:one-source-of-truth] THE registry of state keys the click protocol can
// write. Baseline keys are permanent (refCount is irrelevant for them);
// widget-derived keys are ref-counted across cache entries.
//
// [LAW:types-are-the-program] A `Map` lookup is `(key) → entry | undefined` with
// NO prototype chain — `__proto__`/`constructor` from an untrusted wire URL are
// ordinary non-members, not truthy hits on Object.prototype. A plain object
// would admit those as truthy lookups that crash on invocation (RENDER_FAILED
// instead of the intended BAD_REQUEST). Map makes that unrepresentable.
const _STATE_VALIDATORS = new Map<string, ValidatorEntry>([
  ["style", { validator: validateStyle, permanent: true, refCount: 1 }],
  ["theme", { validator: validateTheme, permanent: true, refCount: 1 }],
  [
    "toolbar-expanded",
    { validator: validateBoolean, permanent: true, refCount: 1 },
  ],
]);

// [LAW:dataflow-not-control-flow] listStateKeys returns a fresh snapshot on each
// call — the snapshot semantics IS the contract. A frozen constant would
// silently misreport the writable surface after a widget config registered a key.
export function listStateKeys(): readonly string[] {
  return [..._STATE_VALIDATORS.keys()];
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
// [LAW:one-source-of-truth] A non-permanent key that is already installed is
// ref-counted, NOT shadowed: the FIRST validator stays authoritative and the
// count increments. This is safe because every derived validator for a given
// key is semantically identical — menus are the only deriver and a page key is
// always integer-valued. (A future heterogeneous deriver — e.g. allow-list
// keys from buttons — must add a compatibility check before this assumption
// holds for it.) Keeping the first validator means two cache entries sharing a
// key, and a reload's new-before-old overlap, both resolve to one consistent gate.
//
// [LAW:single-enforcer] The disposer decrements exactly once (idempotent via the
// `active` flag) and removes the key only when the count reaches zero.
export function registerStateValidator(
  key: string,
  validator: KeyValidator,
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
    existing.refCount++;
  } else {
    _STATE_VALIDATORS.set(key, { validator, permanent: false, refCount: 1 });
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const entry = _STATE_VALIDATORS.get(key);
    if (entry && !entry.permanent) {
      entry.refCount--;
      if (entry.refCount <= 0) _STATE_VALIDATORS.delete(key);
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
// "007"/"−0" can't persist a non-canonical page that the next render's
// `int` read would have to re-normalize. Negative is legal: -1 is the menu's
// CLOSED sentinel.
const INT_RE = /^-?\d+$/;
export function makeIntValidator(label: string): KeyValidator {
  return (raw) => {
    if (!raw) return { ok: false, reason: `${label} value is required` };
    if (!INT_RE.test(raw)) {
      return { ok: false, reason: `${label} must be an integer, got "${raw}"` };
    }
    // parseInt over Number() so the canonical form drops leading zeros / a
    // lone "-0" → "0"; the regex already excludes non-numeric tails.
    return { ok: true, value: String(parseInt(raw, 10)) };
  };
}

// [LAW:one-source-of-truth] The writable-key surface a config's widgets need is
// DERIVED from the widget declarations — the same data the renderer paginates
// from is the gate the wire enforces, so they cannot diverge. A menu writes its
// `state` page key (←/→ navigation + apply-and-close to -1); that key is
// integer-valued. Buttons write only baseline keys (theme/style) for now;
// allow-list derivation for custom buttons keys is a separate follow-up.
//
// [LAW:no-silent-fallbacks] A baseline-colliding page key is NOT skipped — it
// is derived like any other so registerStateValidator throws on the duplicate,
// surfacing a config-load error (a menu naming its page key `theme` is a
// misconfiguration: an integer page key cannot share a column with the theme
// allow-list gate). Skipping would silently leave the theme validator in place
// and the menu's integer ←/→ writes would fail confusingly at click time
// instead of loudly at load. Only the within-config dedupe survives: two menus
// sharing one page key share one int validator (legitimate — same page state),
// registered once rather than throwing on the second.
export function deriveWidgetValidators(
  config: DslConfig,
): ReadonlyArray<{ readonly key: string; readonly validator: KeyValidator }> {
  const out = new Map<string, KeyValidator>();
  for (const widget of Object.values(config.widgets)) {
    if (!isMenuWidget(widget)) continue;
    const key = widget.state;
    if (out.has(key)) continue;
    // [LAW:one-source-of-truth] Label from the KEY, not the widget name: the
    // registry ref-counts by key and keeps the first validator authoritative, so
    // a name-based label would misattribute an error to whichever config/cache
    // entry happened to register first. A key-based label makes every derived
    // validator for a key byte-identical.
    out.set(key, makeIntValidator(`menu page "${key}"`));
  }
  return [...out.entries()].map(([key, validator]) => ({ key, validator }));
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
