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

import { listResolvablePaletteNames } from "../../themes/cascade";
import { STYLE_ORDER } from "../../themes/default-mapping";

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

// [LAW:one-source-of-truth] THE list of state keys the click protocol can
// write. The Map is mutable internally so widget configs can install
// per-config entries at load time via registerStateValidator; the public
// surface is a ReadonlyMap view and a snapshot-on-call listStateKeys().
//
// [LAW:types-are-the-program] `ReadonlyMap` is the type whose lookup is
// `(key) → KeyValidator | undefined` with NO prototype chain — keys like
// `__proto__` or `constructor` from an untrusted wire URL are ordinary
// non-members, not truthy hits on Object.prototype properties. Plain
// object literals (`Record<string, T>`) admit those keys as truthy
// lookups that then crash on invocation — RENDER_FAILED instead of the
// intended BAD_REQUEST. Map makes that crash unrepresentable rather than
// guarded against, matching the in-memory dispatching pattern already
// used in src/daemon/session-state.ts.
const _STATE_VALIDATORS = new Map<string, KeyValidator>([
  ["style", validateStyle],
  ["theme", validateTheme],
  ["toolbar-expanded", validateBoolean],
]);

// [LAW:single-enforcer] One registry, one dispatch path. The exported
// ReadonlyMap aliases the same underlying Map, so iteration and lookups
// always see live state — there is no second store to drift against.
export const STATE_VALIDATORS: ReadonlyMap<string, KeyValidator> =
  _STATE_VALIDATORS;

// [LAW:dataflow-not-control-flow] listStateKeys returns a fresh snapshot
// on each call — the snapshot semantics IS the contract. The previous
// frozen `STATE_KEYS` constant was wrong-by-construction once the
// registry became dynamic: it would have frozen the baseline three at
// module-load time and silently misreport the writable surface to every
// caller after a widget config registered a new key. The function shape
// makes "as-of-now" the only readable value.
export function listStateKeys(): readonly string[] {
  return [..._STATE_VALIDATORS.keys()];
}

// [LAW:locality-or-seam] The widget config (a config-load consumer) owns
// the lifecycle of the validators it installs; this function returns a
// disposer rather than coupling the registry to a global "config reload"
// event. On hot-reload of a DSL config, the cache's reloadInto pattern
// installs new validators into a local first and only disposes the old
// disposers on successful swap — matching the SourceRegistry dispose-
// before-swap contract that keeps a broken reload from corrupting the
// last-known-good state. See src/daemon/cache/render.ts for the wiring.
//
// [LAW:no-silent-fallbacks] Registering a key that already has a
// validator (baseline or previously-installed) throws — silently
// shadowing an existing validator would hide config-authoring bugs
// where two widget configs both claim authority over a key. The
// disposer for the conflict-losing config never runs (the throw
// aborts the entire registration), so partial installation is
// unrepresentable.
//
// [LAW:single-enforcer] The disposer removes exactly its own entry;
// double-dispose is a no-op (the key may have been re-registered by a
// new config in between), not a structural error. Idempotence on the
// caller side is the contract.
export function registerStateValidator(
  key: string,
  validator: KeyValidator,
): () => void {
  if (!key) {
    throw new Error("registerStateValidator: key is required");
  }
  // [LAW:types-are-the-program] The set-state wire parses its tail by
  // splitting on `/`, so a slash-bearing key can never be addressed on
  // the wire — it would be split into two separate segments before
  // dispatch. Listing such a key in listStateKeys() while making it
  // structurally unreachable is the kind of registry-vs-wire drift
  // [LAW:one-source-of-truth] forbids. Reject at registration so the
  // unreachable-but-listed state is unrepresentable.
  if (key.includes("/")) {
    throw new Error(
      `registerStateValidator: key "${key}" contains "/" — the set-state ` +
        `wire shape splits on "/" so a slash-bearing key cannot be ` +
        `addressed. Use a slash-free key.`,
    );
  }
  if (_STATE_VALIDATORS.has(key)) {
    throw new Error(
      `registerStateValidator: key "${key}" already has a validator ` +
        `(existing keys: ${[..._STATE_VALIDATORS.keys()].join(", ")})`,
    );
  }
  _STATE_VALIDATORS.set(key, validator);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (_STATE_VALIDATORS.get(key) === validator) {
      _STATE_VALIDATORS.delete(key);
    }
  };
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

// [LAW:dataflow-not-control-flow] Single entry point for validation: the
// caller hands over (key, value), this returns a uniform ValidateResult
// regardless of whether the key was known. The verb body never branches
// on "did I get a validator" — the absence of a validator IS the rejection.
export function validateStateWrite(
  key: string,
  rawValue: string,
): ValidateResult {
  const validator = _STATE_VALIDATORS.get(key);
  if (!validator) {
    return {
      ok: false,
      reason: `unknown state key "${key}" (have: ${listStateKeys().join(", ")})`,
    };
  }
  return validator(rawValue);
}
