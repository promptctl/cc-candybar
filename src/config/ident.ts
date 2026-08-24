// [LAW:one-source-of-truth] THE identifier-collapse rule — collapse an
// arbitrary name (a segment, action, preset, or menu-host name) to an
// identifier-shaped fragment so synthesized var/action/segment names carry
// no dots, brackets, or other characters that would break a template field
// path or a synthesis-time accumulator key. Every non-alphanumeric RUN
// collapses to a single `_`.
//
// [LAW:no-silent-failure] Multiple sites depend on this SAME collapse
// producing the SAME result for the SAME input: menu-keys.ts derives a
// menu's synthesized SessionState/action identity from it; edit-chrome.ts
// keys synthesized per-preset reset/±-chrome artifacts by it;
// loader/cross-ref.ts's presetIdentCollisions checks that no two preset
// names collide under it BEFORE edit-chrome.ts ever runs. Before this
// module existed, three call sites reimplemented the same regex
// independently (module-privacy taken too far) — a genuine drift risk: if
// one copy changed without the others, the collision GUARD would stop
// matching the collision RULE it exists to enforce, silently reopening the
// exact "second preset steals the first's synthesized action" bug the
// guard was written to prevent. One function now; every site imports it.
export function ident(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_");
}
