// [LAW:one-type-per-behavior] The keyed-validator ALGEBRA, extracted from
// state-validators.ts (candybar-config-engine-71o.2) so it has exactly ONE
// implementation shared by two independent keyspaces: SessionState writes
// (`set` actions, state-validators.ts) and persistent config writes (`persist`
// actions, config-validators.ts). What differs between the two is only DATA —
// which keys are built in, what a config contributes, and what namespace the
// keys live in — so this module is the "one cutter" and each keyspace is an
// instance of it, not a hand-rolled copy of the merge.
//
// [LAW:one-source-of-truth] THE spec algebra: a key's contributions
// (DerivedValidatorSpec[]) collapse to ONE spec via mergeKeySpecs, and a spec
// is residue-projected to a KeyValidator via validatorForSpec. Both keyspaces
// read this from the SAME functions, so "what does a range/allow-list/int
// spec mean" cannot drift between session and config gates.

// [LAW:types-are-the-program] Discriminated union — every legal return is
// either an accepted-and-canonicalized string or a structured rejection
// reason. There is no third state (no `null`, no thrown exception path
// inside a validator). The verb body matches exhaustively on `ok`.
export type ValidateResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

// [LAW:one-type-per-behavior] All key validators have the same shape — they
// don't carry the key name, the registry does. The validator's only concern
// is: does this raw string belong in this key's value-set?
export type KeyValidator = (rawValue: string) => ValidateResult;

// [LAW:types-are-the-program] A derived key's SEMANTIC identity — the data an
// action's `set`/`persist` declares about a key, from which the validator is
// residue. A key is one of three key shapes: an integer (a menu's page
// index), an allow-list (the union of values some button can write), or a
// bounded integer range (a stepper's value). A gate compares specs to decide
// whether two contributions can share a key (same `kind`) and merges them by
// unioning content (allow-list members; range bounds); the opaque
// `KeyValidator` it builds from the spec cannot be compared or merged, which
// is why a contribution is the spec and the gate owns validator construction.
//
// [LAW:one-source-of-truth] The spec carries only content (kind + allow-list
// members + range bounds), never the human label — the label is a pure
// function of the key, computed where the validator is built.
export type DerivedValidatorSpec =
  | { readonly kind: "int" }
  | { readonly kind: "allow-list"; readonly allowed: readonly string[] }
  | {
      // A bounded-integer key (a stepper's value): `min`/`max` gate it. What
      // an UNSET key steps from is not here: it is a value some session's
      // picks resolve, so the step verbs resolve it at click time.
      readonly kind: "range";
      readonly min: number;
      readonly max: number;
    };

// [LAW:one-source-of-truth] One contribution shape — a (key, spec) pair —
// every action's write declaration projects to. mergeContributions folds a
// list of these into the final per-key validator specs, so multiple actions
// writing one key feed ONE coherence merge regardless of which action
// authored the write.
export interface KeySpecContribution {
  readonly key: string;
  readonly spec: DerivedValidatorSpec;
}

const INT_RE = /^-?\d+$/;

// [LAW:one-type-per-behavior] The "values come from list Y" pattern IS the
// canonical widget-config use case (theme picker draws from themes(), style
// picker draws from endcaps(), a custom enum picker draws from a
// user-declared list). One factory builds the validator from the list —
// every callsite that registers an allow-list key passes through the same
// shape, so error messages, empty-input rejection, and lookup semantics are
// identical by construction.
//
// [LAW:no-silent-fallbacks] Empty input is rejected with a label-referencing
// reason rather than silently mapped to a default.
//
// [LAW:one-source-of-truth] `wire` names the ACTUAL wire this allow-list's
// values travel over — "set-state" for SessionState keys, "set-config" for
// config-file (persist) keys — so the slash-rejection message points at the wire
// the operator is actually debugging. Defaults to "set-state" (this
// factory's original, sole caller) so existing direct callers (tests) don't
// need to pass it; validatorForSpec passes the correct wire for its noun.
export function makeAllowListValidator(
  allowed: readonly string[],
  label: string,
  wire: string = "set-state",
): KeyValidator {
  // [LAW:types-are-the-program] The factory's contract is "options = allow
  // list" — every value the picker can RENDER must also be a value the wire
  // can DELIVER. Two structural reasons a declared option can't reach the
  // validator as itself: (1) the wire splits the tail on "/"; (2) the
  // validator's empty-input rejection fires before the allow-list check, so
  // an "" in the allow list would be listed-but-undeliverable. Catching at
  // factory-build time (config-load) surfaces a misconfigured option list
  // immediately, not on the operator's first click.
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

// [LAW:types-are-the-program] An integer-valued state key (a menu's page
// index). The wire delivers a string; the validator IS the parse boundary —
// it accepts only `^-?\d+$` and canonicalizes to the minimal decimal form.
// Negative is legal: -1 is the menu's CLOSED sentinel.
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

// [LAW:types-are-the-program] A bounded-integer state key (a stepper's
// value). The validator is the parse-AND-clamp boundary: it accepts only
// `^-?\d+$` then clamps into [min,max]. [LAW:single-enforcer] This is the ONE
// place bounds are enforced.
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
// single spec that gates it. A key is an INTEGER spec (a paged cursor `int`
// or a bounded `range`) or an allow-list — never both. An integer spec
// ABSORBS integer allow-list members (a trigger writing "0" to a page cursor
// is a legal int write), and a NON-integer member aimed at it is the genuine
// contradiction that throws. Two ranges widen-union; two allow-lists union;
// an int and a range on one key conflict.
// [LAW:one-source-of-truth] `noun` ("state"/"config") names the keyspace in
// every thrown message — this function is the SAME merge both
// deriveActionValidators (state-validators.ts) and deriveConfigActionValidators
// (config-validators.ts) call, so a conflict thrown while merging a `persist`
// action's contributions must say "config", never the SessionState-era
// "state" wording (or the operator debugging a persist action gets pointed at
// the wrong keyspace's mental model).
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
    return { kind: "range", min, max };
  }
  return { kind: "int" };
}

// [LAW:one-source-of-truth] The click-wire verb name a keyspace's writes
// travel over — "set-state" for the SessionState keyspace, "set-config" for
// the config file. Mirrors loader/actions.ts's wireName (same concept, the
// loader's discriminator vocabulary is "set"/"persist" instead of
// "state"/"config").
function wireForNoun(noun: string): string {
  return noun === "config" ? "set-config" : "set-state";
}

// [LAW:types-are-the-program] The validator is RESIDUE of a SETTLED spec:
// given one merged spec, its validator is forced. Pure projection — kind ⇒
// constructor — with NO union or widen of its own. `noun` ("state"/"config")
// is threaded through so the SAME shared projection labels a rejection
// message with the keyspace it actually belongs to — this is the one place
// that builds every validator, so it is the one place that can misname the
// keyspace if the noun doesn't ride along.
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

// [LAW:single-enforcer] THE coherence merge: group every contribution by key
// and collapse each key's specs into the one spec that gates it. `noun`
// names the keyspace (default "state" — the original, sole caller before
// config-validators.ts's twin) so a conflict thrown mid-merge for a
// `persist` action's contributions names the config keyspace, not state.
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
}

// [LAW:types-are-the-program] What ONE config's sessions may write: built
// whole from a set of contributions and never changed after, so a session's
// click is gated — and its stepper wrapped — by the config that session
// renders and by no other the daemon happens to hold.
export interface Gate {
  validate(key: string, rawValue: string): ValidateResult;
  listKeys(): readonly string[];
  rangeParamsFor(key: string): RangeParams | null;
}

// [LAW:no-silent-fallbacks] An unknown key is a caller-visible rejection
// (validate); a contribution that cannot be addressed, re-claims a built-in
// key, or contradicts another on its key is a loud throw — never a silent
// accept-and-store.
//
// [LAW:types-are-the-program] A daemon-wide key is a word list whose members
// come and go while configs stay loaded. A config may add members to it and
// may not give it another shape: refused here by the key alone, whatever the
// list holds at the time, so a config that built its gate once builds it under
// every later change to the members.
function createGate(
  baseline: Readonly<Record<string, KeyValidator>>,
  daemonWide: readonly DaemonWideKey[],
  derived: readonly KeySpecContribution[],
  noun: string,
): Gate {
  const validators = new Map<string, KeyValidator>(Object.entries(baseline));
  const ranges = new Map<string, RangeParams>();
  const daemonKeys = new Set(daemonWide.map((d) => d.key));
  for (const { key, spec } of derived) {
    if (daemonKeys.has(key) && spec.kind !== "allow-list") {
      throw new Error(
        `${noun} gate: key "${key}" is written by the daemon's own links as ` +
          `one of a list of values, and cannot be declared as ` +
          `${spec.kind === "int" ? "a paged cursor (int)" : "a bounded value (range)"}. ` +
          `Use a distinct key.`,
      );
    }
  }
  const contributions: KeySpecContribution[] = [
    ...daemonWide.map(({ key, allowed }) => ({
      key,
      spec: { kind: "allow-list" as const, allowed },
    })),
    ...derived,
  ];
  for (const { key, spec } of mergeContributions(contributions, noun)) {
    if (!key) throw new Error(`${noun} gate: key is required`);
    // [LAW:types-are-the-program] The wire splits its tail on `/`, so a
    // slash-bearing key can never be addressed — listing it would be
    // gate-vs-wire drift.
    if (key.includes("/")) {
      throw new Error(
        `${noun} gate: key "${key}" contains "/" — the wire shape splits on ` +
          `"/" so a slash-bearing key cannot be addressed. Use a slash-free key.`,
      );
    }
    if (Object.hasOwn(baseline, key)) {
      throw new Error(
        `${noun} gate: key "${key}" is a built-in ${noun} key and cannot be ` +
          `re-claimed (built-in keys: ${Object.keys(baseline).join(", ")})`,
      );
    }
    validators.set(key, validatorForSpec(key, spec, noun));
    if (spec.kind === "range") {
      ranges.set(key, { min: spec.min, max: spec.max });
    }
  }
  return {
    validate(key, rawValue) {
      const validator = validators.get(key);
      if (!validator) {
        return {
          ok: false,
          reason: `unknown ${noun} key "${key}" (have: ${[...validators.keys()].join(", ")})`,
        };
      }
      return validator(rawValue);
    },
    listKeys: () => [...validators.keys()],
    rangeParamsFor: (key) => ranges.get(key) ?? null,
  };
}

// Values every session may write to `key`, whatever config it renders.
interface DaemonWideKey {
  readonly key: string;
  readonly allowed: readonly string[];
}

export interface Keyspace<C extends object> {
  // A key every session may write whatever config it renders — the daemon's
  // own links (the update notice's), drawn above any config's bar — and the
  // values they write to it. An empty list holds the key with nothing
  // writable yet; a later registration of the same key adds its members.
  register(key: string, allowed: readonly string[]): () => void;
  // The gate of the sessions rendering `config`.
  gateFor(config: C): Gate;
}

// [LAW:one-type-per-behavior] ONE keyspace implementation, instantiated once
// per wire. `baseline` seeds the built-in keys (raw KeyValidator functions,
// never re-claimable — SessionState's theme/endcaps/toolbar-expanded; none
// for the config file). `derive` is what a config contributes: its action
// table's writes. `noun` names the keyspace in every message
// ("state"/"config").
//
// [LAW:one-source-of-truth] A gate is DERIVED from its config, so there is
// nothing to register when a config loads and nothing to dispose when it
// goes: two configs declaring one key differently each gate their own
// sessions. The memo holds the derivation per config object (a reload is a
// new object) and is dropped whole when a daemon-wide key changes.
// [LAW:no-shared-mutable-globals] The daemon-wide contributions are the one
// mutable thing here, owned by the keyspace and written only through
// `register` and the disposer it returns.
export function createKeyspace<C extends object>(
  baseline: Readonly<Record<string, KeyValidator>>,
  noun: string,
  derive: (config: C) => readonly KeySpecContribution[],
): Keyspace<C> {
  const daemonWide: DaemonWideKey[] = [];
  let epoch = 0;
  const gates = new WeakMap<C, { epoch: number; gate: Gate }>();

  return {
    register(key, allowed) {
      const contribution = { key, allowed };
      // Built before committing: a key the wire cannot address or a built-in
      // re-claimed throws with the keyspace exactly as it was.
      createGate(baseline, [contribution], [], noun);
      daemonWide.push(contribution);
      epoch++;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        daemonWide.splice(daemonWide.indexOf(contribution), 1);
        epoch++;
      };
    },

    gateFor(config) {
      const held = gates.get(config);
      if (held?.epoch === epoch) return held.gate;
      const gate = createGate(baseline, daemonWide, derive(config), noun);
      gates.set(config, { epoch, gate });
      return gate;
    },
  };
}
