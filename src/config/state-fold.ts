// [LAW:one-source-of-truth] The one fold every `state` variable reads its key
// through, kept in the view's store for the render (src/dsl/render.ts) and
// asked here by a click, which reads no store, so a template, a picker's mark,
// a carousel, a stepper and the step it takes all read one value.

import { actionContributions } from "../daemon/foundations/state-validators.js";
import {
  mergeKeySpecs,
  type DerivedValidatorSpec,
} from "../daemon/foundations/validator-registry.js";
import { parseSessionInt } from "../themes/policy.js";
import {
  placementPick,
  stateVarDecls,
  type DslConfig,
  type SettingValue,
  type StateVarDecl,
} from "./dsl-types.js";
import { effectiveGlobal, readStored, type Folded } from "./fold.js";

// A session's stored spelling at a key, read into the value in force: a value
// of the key's domain, or null where nothing is stored and nothing declared.
export type StateFold = (raw: string | null) => Folded<SettingValue | null>;

type Member = (raw: string) => SettingValue | null;

const ANY_INT = { min: -Infinity, max: Infinity };

// [LAW:single-enforcer] A key's domain is the one its click gate derives from
// the config's `set` actions, so a stored spelling is held exactly when it is
// one a click writes, and an integer is held in the spelling the gate writes
// (`parseSessionInt`), kept parsed. A key no action writes holds any spelling.
function memberOf(spec: DerivedValidatorSpec | undefined): Member {
  if (spec === undefined) return (raw) => raw;
  switch (spec.kind) {
    case "allow-list": {
      const allowed: ReadonlySet<string> = new Set(spec.allowed);
      return (raw) => (allowed.has(raw) ? raw : null);
    }
    case "int":
      return (raw) => parseSessionInt(raw, ANY_INT);
    case "range":
      return (raw) => parseSessionInt(raw, spec);
  }
}

// Every key's domain in one config.
export type StateDomains = (key: string) => Member;

// [LAW:one-source-of-truth] A fact of the config alone, derived once per config
// object and shared by every view declaring its variables; the memo is keyed by
// the config it was derived from. Each key's contributions merge through the
// gate's own merge when a variable first reads the key, so a key the gate
// cannot merge fails the variables reading it, and only them.
interface ConfigDomains {
  readonly specs: ReadonlyMap<string, readonly DerivedValidatorSpec[]>;
  readonly members: Map<string, Member>;
}
const DOMAINS = new WeakMap<DslConfig, ConfigDomains>();
export function stateDomains(config: DslConfig): StateDomains {
  let domains = DOMAINS.get(config);
  if (domains === undefined) {
    const specs = new Map<string, DerivedValidatorSpec[]>();
    for (const { key, spec } of actionContributions(config)) {
      specs.set(key, [...(specs.get(key) ?? []), spec]);
    }
    domains = { specs, members: new Map() };
    DOMAINS.set(config, domains);
  }
  const { specs, members } = domains;
  return (key) => {
    const known = members.get(key);
    if (known !== undefined) return known;
    const keySpecs = specs.get(key);
    const member = memberOf(
      keySpecs === undefined ? undefined : mergeKeySpecs(key, keySpecs),
    );
    members.set(key, member);
    return member;
  };
}

// A variable's `default` is what it shows before any pick, parsed as a member
// where it is one: a placeholder no click writes (`(unset)`) shows as written.
export function stateFold(
  decl: StateVarDecl,
  domains: StateDomains,
): StateFold {
  if ("setting" in decl) {
    const { decl: setting, saved } = decl.setting;
    return (raw) => placementPick(setting, saved, raw);
  }
  const member = domains(decl.key);
  const fallback =
    decl.default === undefined ? null : (member(decl.default) ?? decl.default);
  return (raw) =>
    effectiveGlobal(undefined, readStored(raw, member), fallback, null);
}

// The fold a click reads `key` through: its first declared variable's — the
// one the render reads the key back through (`compileInputOf`) — or, for a key
// no variable declares, its domain over nothing.
export function keyFold(config: DslConfig, key: string): StateFold {
  const domains = stateDomains(config);
  for (const [, decl] of stateVarDecls(config)) {
    if (decl.key === key) return stateFold(decl, domains);
  }
  return stateFold({ kind: "state", key }, domains);
}
