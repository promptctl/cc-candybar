// [LAW:one-source-of-truth] THE derivation of a menu's disclosure identity — the
// single place both the loader (which SYNTHESIZES the state var + cycle action)
// and the renderer (which READS openness + emits the toggle) agree on "which key
// holds which open menu". A `{{ menu }}` helper is context-free about its NAME
// (it cannot see the segment it sits in), so the loader and the render walk both
// derive identity from the same two facts — the host segment name and the menu's
// own apply-action name — and MUST produce identical strings or a click would
// write a key the render never reads. Keeping the rule in one module makes that
// agreement structural rather than a coincidence of two copies.
//
// [LAW:decomposition] A menu's identity is `(stateKey, member)`:
//   • member  = the menu's apply-action name — unique per menu within a segment,
//               so two menus in ONE segment are distinct.
//   • stateKey = the SessionState key whose value names the open member. By
//               DEFAULT each menu owns a UNIQUE key (`menus.<seg>.<apply>`), so
//               it toggles only itself — menus are INDEPENDENT. Passing an
//               explicit shared key makes sibling menus share one key
//               (`menus.<key>`); one key holds one open member, so they become
//               mutually exclusive (an accordion) — exactly group sugar's shared-
//               key mechanism, selected by a VALUE not a mode
//               [LAW:dataflow-not-control-flow]. There is no implicit "the row is
//               the key" position magic: identity depends only on names a reader
//               can see in the template, never on tree position.

// [LAW:one-source-of-truth] The reserved namespace every synthesized menu
// artifact (state var + cycle action) lives under, mirroring group sugar's
// `groups.`. A user-authored name under this prefix is a load error so synthesis
// can never silently collide.
export const MENU_NS = "menus.";

// The "no menu open" sentinel a key starts from and returns to on close. A
// menu's member name is its apply-action name; an apply action named exactly
// this would make the cycle [closed, "closed"] (two identical members, never
// openable), which the synthesis pass rejects.
export const MENU_CLOSED = "closed";

// [LAW:representation] Disclosure glyph vocabulary — identical to group sugar so
// every disclosure across the bar reads the same (trailing the label/content it
// gates, per pdu.8): collapsed ▸, expanded ▾.
export const MENU_GLYPH_CLOSED = "▸";
export const MENU_GLYPH_OPEN = "▾";

// [LAW:types-are-the-program] Collapse an arbitrary name to an identifier-shaped
// id so the synthesized var/action/SessionState-key names carry no dots or
// brackets that would break template field paths. Distinct names never collide
// under this map for the alphanumeric segment/action names the config uses.
function ident(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_");
}

// [LAW:single-enforcer] A menu's member name IS its apply-action name. Both the
// loader and the helper call this so neither restates the rule.
export function menuMember(applyName: string): string {
  return applyName;
}

// [LAW:single-enforcer] THE state key for a menu. Independent (no shared key):
// unique per (segment, apply) so the menu toggles only itself. Shared key: the
// key all siblings passing the same string agree on, so one open member wins
// (accordion). The shared form ignores the segment name on purpose — that is how
// menus in DIFFERENT segments become mutually exclusive.
export function menuStateKey(
  segName: string,
  applyName: string,
  sharedKey: string | undefined,
): string {
  return sharedKey !== undefined
    ? MENU_NS + ident(sharedKey)
    : MENU_NS + ident(segName) + "." + ident(applyName);
}

// The synthesized cycle action a menu's disclosure toggle realizes: writing its
// state key between MENU_CLOSED and its member. Named per (stateKey, member) so
// menus sharing a key contribute distinct cycles on it — the existing same-key
// validator merge unions their members into one gate.
export function menuActionName(stateKey: string, member: string): string {
  return stateKey + "." + member;
}
