// [LAW:one-type-per-behavior] ONE registry algebra for both keyspaces; what differs is DATA.
// [LAW:one-source-of-truth] One spec merge, one projection, so a spec cannot drift per keyspace.

// [LAW:types-are-the-program] An accepted string or a structured rejection; no third state.
export type ValidateResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

// [LAW:one-type-per-behavior] A validator does not carry its key name; the registry does.
export type KeyValidator = (rawValue: string) => ValidateResult;

// [LAW:types-are-the-program] Registration takes the SPEC because the opaque KeyValidator
// cannot be compared or merged. [LAW:one-source-of-truth] A spec carries no label.
export type DerivedValidatorSpec =
  | { readonly kind: "int" }
  | { readonly kind: "allow-list"; readonly allowed: readonly string[] }
  | {
      // [LAW:one-source-of-truth] `seed` is what an UNSET key reads as, not `min`.
      readonly kind: "range";
      readonly min: number;
      readonly max: number;
      readonly seed: number;
    };

// [LAW:one-source-of-truth] One shape, so every action on a key feeds ONE coherence merge.
export interface KeySpecContribution {
  readonly key: string;
  readonly spec: DerivedValidatorSpec;
}

const INT_RE = /^-?\d+$/;

// [LAW:one-source-of-truth] The unset seed is the backing default, the number already shown.
export function clampSeed(
  seed: number | undefined,
  min: number,
  max: number,
): number {
  if (seed === undefined) return min;
  return Math.max(min, Math.min(max, seed));
}

// [LAW:one-type-per-behavior] One factory builds every allow-list validator, so messages
// and lookup semantics are identical by construction.
// [LAW:no-silent-fallbacks] Empty input is rejected with a label-referencing reason.
// [LAW:one-source-of-truth] `wire` names the ACTUAL wire these values travel over.
export function makeAllowListValidator(
  allowed: readonly string[],
  label: string,
  wire: string = "set-state",
): KeyValidator {
  // [LAW:types-are-the-program] Every value the picker can RENDER must be one the wire can
  // DELIVER — caught at config-load, not on the operator's first click.
  const slashOffenders = allowed.filter((v) => v.includes("/"));
  if (slashOffenders.length > 0) {
    throw new Error(
      `makeAllowListValidator(${label}): values contain "/" — the ${wire} ` +
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

// [LAW:types-are-the-program] The validator IS the parse boundary. -1 is the CLOSED sentinel.
export function makeIntValidator(label: string): KeyValidator {
  return (raw) => {
    if (!raw) return { ok: false, reason: `${label} value is required` };
    if (!INT_RE.test(raw)) {
      return { ok: false, reason: `${label} must be an integer, got "${raw}"` };
    }
    const neg = raw[0] === "-";
    const digits = (neg ? raw.slice(1) : raw).replace(/^0+/, "");
    if (digits === "") return { ok: true, value: "0" };
    return { ok: true, value: neg ? `-${digits}` : digits };
  };
}

// [LAW:types-are-the-program][LAW:single-enforcer] Parse-AND-clamp: the ONE bounds check.
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

// [LAW:types-are-the-program] A key is an INTEGER spec or an allow-list, never both: an int
// absorbs int members, a non-integer one throws. [LAW:one-source-of-truth] `noun` names the keyspace.
export function mergeKeySpecs(
  key: string,
  specs: readonly DerivedValidatorSpec[],
  noun: string = "state",
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
  const nonInt = allowed.filter((v) => !INT_RE.test(v));
  if (nonInt.length > 0) {
    throw new Error(
      `${noun} action table: key "${key}" is an integer spec (a paged ` +
        `cursor or a bounded value) but a click writes non-integer ` +
        `value(s) to it (${nonInt.join(", ")}). A ${noun} key has one key ` +
        `shape — point that click at a distinct key, or write an integer.`,
    );
  }
  if (hasInt && ranges.length > 0) {
    throw new Error(
      `${noun} action table: key "${key}" is declared as both a paged ` +
        `cursor (int) and a bounded value (range) — a ${noun} key has one key ` +
        `shape. Use distinct keys.`,
    );
  }
  if (ranges.length > 0) {
    const min = Math.min(...ranges.map((r) => r.min));
    const max = Math.max(...ranges.map((r) => r.max));
    const outOfRange = allowed.filter((v) => {
      const n = parseInt(v, 10);
      return n < min || n > max;
    });
    if (outOfRange.length > 0) {
      throw new Error(
        `${noun} action table: key "${key}" is a bounded range [${min},${max}] ` +
          `but a click writes out-of-range value(s) to it ` +
          `(${outOfRange.join(", ")}). The range gate would clamp them, storing a ` +
          `different value than the click renders — write an in-range integer, ` +
          `or point that click at a distinct key.`,
      );
    }
    const seed = clampSeed(ranges[0]!.seed, min, max);
    return { kind: "range", min, max, seed };
  }
  return { kind: "int" };
}

// [LAW:one-source-of-truth] The click-wire verb name a keyspace's writes travel over.
function wireForNoun(noun: string): string {
  return noun === "config" ? "set-config" : "set-state";
}

// [LAW:types-are-the-program] The validator is RESIDUE of a settled spec — pure projection,
// no union or widen of its own; `noun` rides along so it cannot misname the keyspace.
function validatorForSpec(
  key: string,
  spec: DerivedValidatorSpec,
  noun: string,
): KeyValidator {
  if (spec.kind === "int") return makeIntValidator(`menu page "${key}"`);
  if (spec.kind === "range")
    return makeRangeValidator(spec.min, spec.max, `${noun} stepper "${key}"`);
  return makeAllowListValidator(
    spec.allowed,
    `${noun} "${key}"`,
    wireForNoun(noun),
  );
}

function buildValidatorFromSpecs(
  key: string,
  specs: readonly DerivedValidatorSpec[],
  noun: string,
): KeyValidator {
  return validatorForSpec(key, mergeKeySpecs(key, specs, noun), noun);
}

// [LAW:single-enforcer] THE coherence merge: group by key, collapse each key's specs to one.
export function mergeContributions(
  contributions: readonly KeySpecContribution[],
  noun: string = "state",
): KeySpecContribution[] {
  const byKey = new Map<string, DerivedValidatorSpec[]>();
  for (const { key, spec } of contributions) {
    const specs = byKey.get(key);
    if (specs) specs.push(spec);
    else byKey.set(key, [spec]);
  }
  return [...byKey].map(([key, specs]) => ({
    key,
    spec: mergeKeySpecs(key, specs, noun),
  }));
}

export interface RangeParams {
  readonly min: number;
  readonly max: number;
  readonly seed: number;
}

interface BaselineEntry {
  readonly permanent: true;
  readonly validator: KeyValidator;
}
interface DerivedEntry {
  readonly permanent: false;
  readonly kind: DerivedValidatorSpec["kind"];
  validator: KeyValidator;
  readonly specs: DerivedValidatorSpec[];
}
type ValidatorEntry = BaselineEntry | DerivedEntry;

export interface ValidatorRegistry {
  register(key: string, spec: DerivedValidatorSpec): () => void;
  validate(key: string, rawValue: string): ValidateResult;
  listKeys(): readonly string[];
  // [LAW:one-source-of-truth] Read from the registry that owns the derived/permanent split.
  listBaselineKeys(): readonly string[];
  rangeParamsFor(key: string): RangeParams | null;
}

// [LAW:one-type-per-behavior] ONE registry implementation per keyspace; `baseline` seeds
// never-re-claimable entries. [LAW:no-silent-fallbacks] An unknown key is never stored.
export function createValidatorRegistry(
  baseline: Readonly<Record<string, KeyValidator>>,
  noun: string = "state",
): ValidatorRegistry {
  const entries = new Map<string, ValidatorEntry>(
    Object.entries(baseline).map(([key, validator]) => [
      key,
      { validator, permanent: true } as const,
    ]),
  );

  function baselineKeys(): readonly string[] {
    const out: string[] = [];
    for (const [key, entry] of entries) if (entry.permanent) out.push(key);
    return out;
  }

  return {
    register(key, spec) {
      if (!key) throw new Error("register: key is required");
      // [LAW:types-are-the-program] The wire splits on `/`: a slash key would be unaddressable.
      if (key.includes("/")) {
        throw new Error(
          `register: key "${key}" contains "/" — the wire shape splits on ` +
            `"/" so a slash-bearing key cannot be addressed. Use a slash-free key.`,
        );
      }
      const existing = entries.get(key);
      if (existing) {
        if (existing.permanent) {
          throw new Error(
            `register: key "${key}" is a built-in ${noun} key and cannot be ` +
              `re-claimed (built-in keys: ${[...baselineKeys()].join(", ")})`,
          );
        }
        if (existing.kind !== spec.kind) {
          throw new Error(
            `register: key "${key}" is already a ${existing.kind} ${noun} key; ` +
              `cannot also register it as ${spec.kind}. A ${noun} key has one ` +
              `key shape — a menu page index (int) and a button allow-list ` +
              `cannot share a key.`,
          );
        }
        existing.specs.push(spec);
        existing.validator = buildValidatorFromSpecs(key, existing.specs, noun);
      } else {
        const specs = [spec];
        entries.set(key, {
          permanent: false,
          kind: spec.kind,
          validator: buildValidatorFromSpecs(key, specs, noun),
          specs,
        });
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const entry = entries.get(key);
        if (!entry || entry.permanent) return;
        const i = entry.specs.indexOf(spec);
        if (i >= 0) entry.specs.splice(i, 1);
        if (entry.specs.length === 0) {
          entries.delete(key);
        } else {
          entry.validator = buildValidatorFromSpecs(key, entry.specs, noun);
        }
      };
    },

    validate(key, rawValue) {
      const entry = entries.get(key);
      if (!entry) {
        return {
          ok: false,
          reason: `unknown ${noun} key "${key}" (have: ${[...entries.keys()].join(", ")})`,
        };
      }
      return entry.validator(rawValue);
    },

    listKeys() {
      return [...entries.keys()];
    },

    listBaselineKeys() {
      return baselineKeys();
    },

    rangeParamsFor(key) {
      const entry = entries.get(key);
      if (!entry || entry.permanent || entry.kind !== "range") return null;
      const spec = mergeKeySpecs(key, entry.specs, noun);
      if (spec.kind !== "range") {
        throw new Error(
          `rangeParamsFor: key "${key}" holds range specs but the merge ` +
            `produced a ${spec.kind} spec — the entry-kind invariant is broken.`,
        );
      }
      return { min: spec.min, max: spec.max, seed: spec.seed };
    },
  };
}
