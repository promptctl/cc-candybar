// [LAW:one-source-of-truth] A plugin's identity, downhill of everything that
// names one: the loader that mints it, the parse that keeps a config's own
// names out of it, and the cross-ref that explains a placement missing from it.

// Every name a plugin declares lives under its namespace, `<scope>.<plugin>.`:
// no plugin can collide with a name the bar or the user declares, and nothing
// outside one is ever a plugin's. The scope is where the definition was found
// — `plugins` for an installed one (the user's or a package manager's root, or
// a list in the user's own config), `repo` for one a repository brings (its
// plugin root, or a list in its config) — so a repo's plugin never replaces an
// installed one of the same name.
export const PLUGIN_SCOPES = ["plugins", "repo"] as const;
export type PluginScope = (typeof PLUGIN_SCOPES)[number];

export interface PluginId {
  readonly scope: PluginScope;
  readonly name: string;
}

// [LAW:types-are-the-program] A definition and the plugin it is: its scope,
// and its name. Its namespace is derived (`pluginNs`), never carried beside it.
export type NamedDefinition = PluginId & { readonly path: string };

// [LAW:single-enforcer] The one spelling of a plugin's namespace.
export function pluginNs({ scope, name }: PluginId): string {
  return `${scope}.${name}`;
}

// Whether a declared name is the plugin's: its namespace, `<scope>.<plugin>`,
// where a dropped plugin's tombstone stands, and everything under it.
export function ownedBy(ns: string): (name: string) => boolean {
  return (name) => name === ns || name.startsWith(`${ns}.`);
}

// [LAW:types-are-the-program] What a placed name is, in the session the
// config renders for: a segment the config declares; one under a plugin
// namespace no plugin renders here (a `repo.` cell outside its repository, a
// plugin not installed), which is data, like a false `when`; one a plugin
// that does render here does not declare, with the definition that won; or
// one nothing explains.
export type SegmentPresence =
  | { readonly kind: "declared" }
  | { readonly kind: "absent" }
  | { readonly kind: "plugin"; readonly definition: NamedDefinition }
  | { readonly kind: "missing" };

// The scope-free name a plugin's own definition calls itself by: the loader
// binds it to the namespace the plugin loads under, so one definition loads
// alike from a repository and from an install.
export const SELF = "self";

// The plugin scope a name sits in — the scope's own root included — if any.
export function scopeOf(name: string): PluginScope | undefined {
  return PLUGIN_SCOPES.find((s) => name === s || name.startsWith(`${s}.`));
}

// [LAW:no-silent-failure] Why a name under one scope names nothing when the
// same name under the other does: never resolved through it, but said, so a
// placement of `plugins.lit.ticket` in a repo that ships `repo.lit.ticket`
// (or the reverse) names the spelling that exists.
export function otherScopeHint(
  name: string,
  declared: (name: string) => boolean,
): string {
  const scope = scopeOf(name);
  if (scope === undefined || scope === name) return "";
  const other = PLUGIN_SCOPES.filter((s) => s !== scope)
    .map((s) => `${s}${name.slice(scope.length)}`)
    .find(declared);
  return other === undefined
    ? ""
    : ` ("${other}" is declared: a repository's own plugins are named under repo., installed ones under plugins., and a name in one is never looked up in the other)`;
}
