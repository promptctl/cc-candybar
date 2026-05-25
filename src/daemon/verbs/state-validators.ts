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
const validateTheme: KeyValidator = (raw) => {
  if (!raw) return { ok: false, reason: "theme name is required" };
  const themes = listResolvablePaletteNames();
  if (!themes.includes(raw)) {
    return {
      ok: false,
      reason: `unknown theme "${raw}" (have: ${themes.join(", ")})`,
    };
  }
  return { ok: true, value: raw };
};

const validateStyle: KeyValidator = (raw) => {
  if (!raw) return { ok: false, reason: "style name is required" };
  if (!STYLE_ORDER.includes(raw)) {
    return {
      ok: false,
      reason: `unknown style "${raw}" (have: ${STYLE_ORDER.join(", ")})`,
    };
  }
  return { ok: true, value: raw };
};

// [LAW:dataflow-not-control-flow] Boolean-ish accepts four canonical
// inputs and normalizes to two canonical outputs: truthy → "1", falsy →
// "" (empty). The empty string is the same sentinel `toolbar-toggle`
// produces via `clear()` for the next render — readers treat both as
// "off" because the DSL state binding's default fires on null/empty.
// Centralizing this canonical pair here means any future widget that
// writes a boolean state key gets the same on/off contract by registry
// row, not by re-deriving it inline.
const BOOLEAN_TRUTHY = new Set(["1", "true"]);
const BOOLEAN_FALSY = new Set(["0", "false", ""]);
const validateBoolean: KeyValidator = (raw) => {
  if (BOOLEAN_TRUTHY.has(raw)) return { ok: true, value: "1" };
  if (BOOLEAN_FALSY.has(raw)) return { ok: true, value: "" };
  return {
    ok: false,
    reason: `expected boolean-ish (1, 0, true, false), got "${raw}"`,
  };
};

// [LAW:one-source-of-truth] THE list of state keys the click protocol can
// write. Alphabetical for diff-stability — order is not load-bearing.
export const STATE_VALIDATORS: Readonly<Record<string, KeyValidator>> =
  Object.freeze({
    style: validateStyle,
    theme: validateTheme,
    "toolbar-expanded": validateBoolean,
  });

// Exported for error messages (the BAD_REQUEST surfaces this list so the
// caller learns the writable schema without a separate API call).
export const STATE_KEYS: readonly string[] = Object.freeze(
  Object.keys(STATE_VALIDATORS),
) as readonly string[];

// [LAW:dataflow-not-control-flow] Single entry point for validation: the
// caller hands over (key, value), this returns a uniform ValidateResult
// regardless of whether the key was known. The verb body never branches
// on "did I get a validator" — the absence of a validator IS the rejection.
export function validateStateWrite(
  key: string,
  rawValue: string,
): ValidateResult {
  const validator = STATE_VALIDATORS[key];
  if (!validator) {
    return {
      ok: false,
      reason: `unknown state key "${key}" (have: ${STATE_KEYS.join(", ")})`,
    };
  }
  return validator(rawValue);
}
