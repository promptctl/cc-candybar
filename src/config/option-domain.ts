// [LAW:one-type-per-behavior] An option domain is a NAME → domain lookup,
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
// the domain. render/action.ts (rendering options) and
// daemon/verbs/state-validators.ts (deriving the click gate) both call
// through here instead of each hand-rolling the themes/styles/looks branch —
// the rendered options and the derived gate cannot diverge because there is
// no second resolver.

import type { Palette, ThemeKey } from "@promptctl/rich-js";
import {
  CHARSETS,
  COLOR_COMPATIBILITIES,
  listResolvablePaletteNames,
  STRIP_STYLES,
} from "../themes/policy.js";
import {
  paletteForThemeName,
  transposedPalette,
} from "../themes/palette-resolvers.js";
import { presetNames } from "./presets.js";

// [LAW:types-are-the-program] The authoring shape of a `set … from` value: a
// bare string names a domain (resolved through the registry or a per-config
// override); a non-empty array of strings IS the domain, inline, needing no
// name and no registration. Mirrors the `cycle` field's array shape — an
// author already knows this pattern.
export type OptionDomain = string | readonly string[];

export type OptionDomainResolver = () => readonly string[];

// [LAW:types-are-the-program] The one fact that makes a domain COLOUR-VALUED:
// the palette that picking a member would put in force. `themes` answers with
// the theme's own palette; `looks` answers with the render's base palette
// transposed by that look's ThemeKey. Every other domain (styles, presets,
// charsets, an inline array, edit mode's addable segment names) has no answer,
// which is exactly the absence below.
//
// `base` is the palette the render's LOOK applies to — never a palette that has
// already been transposed. `transposedPalette` must not be chained: its memo
// keys on the base palette's NAME, which transposition preserves, so
// transposing an already-looked palette both double-pays OKLCH quantization and
// collides the shared memo (gruvbox+vivid vs gruvbox+dim+vivid). The render
// publishes its base on ActionRuntime for exactly this reason.
export type OptionPalette = (option: string, base: Palette) => Palette;

// [LAW:one-source-of-truth] Resolving a domain yields the DOMAIN, not one facet
// of it. Members and "how a member paints itself" are two things the SAME
// registration knows, so they arrive together and cannot drift: a colour-valued
// domain that some consumer resolved as bare members would be a domain whose
// colour half exists for the gate but not the render.
//
// [LAW:dataflow-not-control-flow] `paletteOf`'s PRESENCE is the discriminator —
// the same move the segment type makes with an authored `bg?:`, not a new
// `coloured: true` flag beside a field that already says it.
export interface ResolvedDomain {
  readonly members: readonly string[];
  readonly paletteOf?: OptionPalette;
}

interface DomainEntry {
  readonly permanent: boolean;
  readonly resolve: OptionDomainResolver;
  readonly paletteOf?: OptionPalette;
}

const _GLOBAL_OPTION_DOMAINS = new Map<string, DomainEntry>();

function registerBuiltinDomain(
  name: string,
  resolve: OptionDomainResolver,
  paletteOf?: OptionPalette,
): void {
  _GLOBAL_OPTION_DOMAINS.set(name, { permanent: true, resolve, paletteOf });
}

// [LAW:one-source-of-truth] "themes"/"styles" become ORDINARY registrations —
// the same registerOptionDomain any future caller uses — reading the same
// canonical lists the set-state validator and the `themes()`/`styles()`
// template bindings already consult (listResolvablePaletteNames/
// STRIP_STYLES). No special-cased branch remains anywhere downstream.
//
// A theme member paints itself through the ONE
// name -> Palette enforcer (palette-resolvers.ts, already memoized per name),
// the same one the render resolves its own base palette through — so an option
// cell and the bar it would produce cannot come from two constructions. The
// render's CURRENT look is deliberately not composed in: the cell shows the
// theme being chosen, and the look control beside it shows the look.
registerBuiltinDomain(
  "themes",
  () => listResolvablePaletteNames(),
  (option) => paletteForThemeName(option),
);
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
  // A colour-valued registration says so here (see OptionPalette) — the same
  // channel the built-in `themes` uses, so a future domain over palettes needs
  // no new plumbing anywhere downstream.
  paletteOf?: OptionPalette,
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
  _GLOBAL_OPTION_DOMAINS.set(name, { permanent: false, resolve, paletteOf });
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
  readonly looks: Readonly<Record<string, ThemeKey>>;
  readonly presets: Readonly<Record<string, unknown>>;
}): ReadonlyMap<string, ResolvedDomain> {
  return new Map([
    [
      "looks",
      {
        members: Object.keys(config.looks),
        // [LAW:one-source-of-truth] A look IS a ThemeKey, and the one
        // construction of an adapted palette is transposedPalette — the same
        // call renderDsl makes for the look actually in force. One
        // transposition of the BASE, never a second over an already-looked
        // palette (see OptionPalette).
        // [LAW:no-defensive-null-guards] The members above ARE this map's keys,
        // so a member always names a declared look.
        paletteOf: (option: string, base: Palette) =>
          transposedPalette(base, config.looks[option]!),
      },
    ],
    // [LAW:one-source-of-truth] Not `Object.keys` — the floor is selectable
    // whether or not a config declares it, and presetNames is where that is
    // stated (once, for the gate and the render alike).
    ["presets", { members: presetNames(config.presets) }],
  ]);
}

// [LAW:one-source-of-truth] The full set of names `from` may legally name for
// THIS config: every globally-registered domain plus this config's per-config
// overrides (currently just "looks"). Used both to resolve a name and to spell
// out the legal set in an unknown-domain error.
export function knownOptionDomainNames(
  perConfigDomains: ReadonlyMap<string, ResolvedDomain>,
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
  perConfigDomains: ReadonlyMap<string, ResolvedDomain>,
): ResolvedDomain {
  // An inline array is its own domain — a bare list of words, so it can never
  // be colour-valued, structurally rather than by a check.
  if (typeof from !== "string") return { members: from };
  const local = perConfigDomains.get(from);
  if (local) return local;
  const entry = _GLOBAL_OPTION_DOMAINS.get(from);
  if (entry) return { members: entry.resolve(), paletteOf: entry.paletteOf };
  throw new Error(
    `unknown option domain "${from}" (have: ${knownOptionDomainNames(perConfigDomains).join(", ")})`,
  );
}
