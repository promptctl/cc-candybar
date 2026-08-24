// [LAW:one-type-per-behavior] An option domain is a NAME → members lookup,
// regardless of where the members come from. Before this module, "themes" /
// "styles" / "looks" were three special-cased branches wearing a closed
// TypeScript union (OptionSource) — a hardcoded list of legal domain NAMES
// with extra steps. There is exactly one domain concept: a `from` value is
// either an INLINE literal domain (an authored array — zero registration,
// zero engine edit) or the NAME of a domain resolved through this registry.
// Adding a new registry-backed domain is one `registerOptionDomain` call
// (data), never a new union member every consumer must re-match on.
//
// [LAW:no-shared-mutable-globals] `_GLOBAL_OPTION_DOMAINS` is shared mutable
// state with exactly one owner (this module) and one explicit API
// (registerOptionDomain / resolveOptionDomain / knownOptionDomainNames). It
// holds only domains whose members are legitimately PROCESS-lifetime static
// (themes, styles — module-init snapshots, same reasoning as
// template-engine/funcs.ts's THEMES_LIST/STYLES_LIST caches). A domain whose
// members vary PER CONFIG (the merged `looks:` block — two daemon render-cache
// entries can hold different looks blocks for different configs
// simultaneously) can never live here; it is threaded explicitly as
// `perConfigDomains`, the same way `lookNames` already is.
//
// [LAW:one-source-of-truth] This is the ONE place a domain name resolves to
// its members. render/action.ts (rendering options) and
// daemon/verbs/state-validators.ts (deriving the click gate) both call
// through here instead of each hand-rolling the themes/styles/looks branch —
// the rendered options and the derived gate cannot diverge because there is
// no second resolver.

import {
  CHARSETS,
  COLOR_COMPATIBILITIES,
  listResolvablePaletteNames,
  STRIP_STYLES,
} from "../themes/policy.js";
import { presetNames } from "./presets.js";

// [LAW:types-are-the-program] The authoring shape of a `set … from` value: a
// bare string names a domain (resolved through the registry or a per-config
// override); a non-empty array of strings IS the domain, inline, needing no
// name and no registration. Mirrors the `cycle` field's array shape — an
// author already knows this pattern.
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

// [LAW:one-source-of-truth] "themes"/"styles" become ORDINARY registrations —
// the same registerOptionDomain any future caller uses — reading the same
// canonical lists the set-state validator and the `themes()`/`styles()`
// template bindings already consult (listResolvablePaletteNames/
// STRIP_STYLES). No special-cased branch remains anywhere downstream.
registerBuiltinDomain("themes", () => listResolvablePaletteNames());
registerBuiltinDomain("styles", () => STRIP_STYLES);
// [LAW:one-source-of-truth] Same shape as themes/styles: the exact consts
// the loader's own field validation and the render layer's glyph/color-depth
// dispatch already derive from (themes/policy.ts CHARSETS/COLOR_COMPATIBILITIES)
// — a menu drawing from these can never enumerate a value the render layer
// would reject.
registerBuiltinDomain("charsets", () => CHARSETS);
registerBuiltinDomain("colorCompatibilities", () => COLOR_COMPATIBILITIES);

// [LAW:no-silent-fallbacks] A built-in domain can never be re-claimed — a
// config or feature registering a custom domain named "themes" gets a loud
// load-time error, never a silent shadow of the real theme list. Registering
// returns a disposer (same shape as registerStateValidator) so a caller with
// a bounded lifetime (a test, a future per-feature domain) can clean up.
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

// [LAW:one-source-of-truth] THE single construction of a config's per-config
// domain overrides — the domains whose members are declared IN the config
// rather than in the registry above: "looks" (the merged `looks:` block) and
// "presets" (the merged `presets:` block). cross-ref.ts (checking a `from` name
// resolves), state-validators.ts (deriving the click gate), and dsl/render.ts
// (compiling render-time options) each need this map; before this function they
// each rebuilt it independently, three sites that could silently drift if a
// future per-config domain were added to only some of them.
//
// [LAW:locality-or-seam] The parameter is the CONFIG, structurally typed to the
// blocks read here — not one positional record per domain. Presets were the
// second per-config domain, and adding them under the old `(looks)` signature
// would have rippled a new argument through all three call sites; under this
// one, a third domain is a single line HERE and nothing else moves. Structural
// (rather than importing DslConfig) so this leaf module still never imports
// dsl-types.ts — that would cycle through dsl-types.ts -> action.ts ->
// option-domain.ts (type-only, but still a cycle this module stays clear of,
// per [LAW:one-way-deps]).
export function perConfigDomainsFor(config: {
  readonly looks: Readonly<Record<string, unknown>>;
  readonly presets: Readonly<Record<string, unknown>>;
}): ReadonlyMap<string, readonly string[]> {
  return new Map([
    ["looks", Object.keys(config.looks)],
    // [LAW:one-source-of-truth] Not `Object.keys` — the floor is selectable
    // whether or not a config declares it, and presetNames is where that is
    // stated (once, for the gate and the render alike).
    ["presets", presetNames(config.presets)],
  ]);
}

// [LAW:one-source-of-truth] The full set of names `from` may legally name for
// THIS config: every globally-registered domain plus this config's per-config
// overrides (currently just "looks"). Used both to resolve a name and to spell
// out the legal set in an unknown-domain error.
export function knownOptionDomainNames(
  perConfigDomains: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  return [
    ...new Set([..._GLOBAL_OPTION_DOMAINS.keys(), ...perConfigDomains.keys()]),
  ];
}

// [LAW:dataflow-not-control-flow] One total resolution: an inline array IS
// its own domain (no lookup); a string is a NAME resolved first against this
// config's per-config overrides, then the global registry. A name matching
// neither is a genuine error — the loader's cross-ref pass already proved
// every `from` name resolves before this runs, so a miss here is a
// caller/wiring bug, not a config-authoring mistake.
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
