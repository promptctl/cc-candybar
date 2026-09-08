// [LAW:one-type-per-behavior][LAW:one-source-of-truth] An option domain is the ONE
// NAME → members lookup: a `from` value is either an INLINE literal array or the
// NAME of a registered domain. [LAW:no-shared-mutable-globals] The registry holds
// only PROCESS-lifetime static domains; per-config members thread as a parameter.

import {
  CHARSETS,
  COLOR_COMPATIBILITIES,
  listResolvablePaletteNames,
  STRIP_STYLES,
} from "../themes/policy.js";
import { presetNames } from "./presets.js";

// [LAW:types-are-the-program] A bare string names a domain; an array IS the domain.
export type OptionDomain = string | readonly string[];

export type OptionDomainResolver = () => readonly string[];

interface DomainEntry {
  readonly permanent: boolean;
  readonly resolve: OptionDomainResolver;
}

const _GLOBAL_OPTION_DOMAINS = new Map<string, DomainEntry>();

function registerBuiltinDomain(
  name: string,
  resolve: OptionDomainResolver,
): void {
  _GLOBAL_OPTION_DOMAINS.set(name, { permanent: true, resolve });
}

// [LAW:one-source-of-truth] Ordinary registrations over the same canonical lists.
registerBuiltinDomain("themes", () => listResolvablePaletteNames());
registerBuiltinDomain("styles", () => STRIP_STYLES);
// [LAW:one-source-of-truth] Same shape; a menu cannot offer a value render rejects.
registerBuiltinDomain("charsets", () => CHARSETS);
registerBuiltinDomain("colorCompatibilities", () => COLOR_COMPATIBILITIES);

// [LAW:no-silent-fallbacks] A built-in domain can never be re-claimed; returns a disposer.
export function registerOptionDomain(
  name: string,
  resolve: OptionDomainResolver,
): () => void {
  const existing = _GLOBAL_OPTION_DOMAINS.get(name);
  if (existing) {
    throw new Error(
      `registerOptionDomain: option domain "${name}" is already registered` +
        (existing.permanent
          ? " (a built-in domain — built-ins cannot be reclaimed)"
          : ""),
    );
  }
  _GLOBAL_OPTION_DOMAINS.set(name, { permanent: false, resolve });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const entry = _GLOBAL_OPTION_DOMAINS.get(name);
    if (entry && !entry.permanent) _GLOBAL_OPTION_DOMAINS.delete(name);
  };
}

// [LAW:one-source-of-truth][LAW:locality-or-seam] THE single construction of a
// config's per-config domains, structurally typed so this leaf module never imports
// dsl-types.ts [LAW:one-way-deps].
export function perConfigDomainsFor(config: {
  readonly looks: Readonly<Record<string, unknown>>;
  readonly presets: Readonly<Record<string, unknown>>;
}): ReadonlyMap<string, readonly string[]> {
  return new Map([
    ["looks", Object.keys(config.looks)],
    // [LAW:one-source-of-truth] Not `Object.keys` — the floor is always selectable.
    ["presets", presetNames(config.presets)],
  ]);
}

// [LAW:one-source-of-truth] Every name `from` may legally take for THIS config.
export function knownOptionDomainNames(
  perConfigDomains: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  return [
    ...new Set([..._GLOBAL_OPTION_DOMAINS.keys(), ...perConfigDomains.keys()]),
  ];
}

// [LAW:dataflow-not-control-flow] One total resolution. A miss is a wiring bug:
// cross-ref already proved every `from` name resolves.
export function resolveOptionDomain(
  from: OptionDomain,
  perConfigDomains: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  if (typeof from !== "string") return from;
  const local = perConfigDomains.get(from);
  if (local) return local;
  const entry = _GLOBAL_OPTION_DOMAINS.get(from);
  if (entry) return entry.resolve();
  throw new Error(
    `unknown option domain "${from}" (have: ${knownOptionDomainNames(perConfigDomains).join(", ")})`,
  );
}
