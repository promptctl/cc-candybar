// [LAW:one-source-of-truth][LAW:one-type-per-behavior][LAW:decomposition] THE
// disclosure primitive: a binary toggle over a SessionState key holding the CLOSED
// sentinel or one MEMBER name; siblings sharing a key are an accordion.
// [LAW:one-way-deps] Pure — type-only imports, so loader and render can share it.

import type { ActionDecl } from "./action.js";
import type {
  ContainerNode,
  DisclosureRef,
  SegmentNode,
  VariableDecl,
} from "./dsl-types.js";

// The "nothing open" sentinel; a member equal to it would never be openable.
export const DISCLOSURE_CLOSED = "closed";

// [LAW:representation] One glyph pair for the whole bar: collapsed ▸, expanded ▾.
// [LAW:one-source-of-truth] The AUTHORED default, never an emission.
export const DISCLOSURE_GLYPH_CLOSED = "▸";
export const DISCLOSURE_GLYPH_OPEN = "▾";

// [LAW:one-source-of-truth] The one glyph that CLOSES an open disclosure.
export const DISCLOSURE_GLYPH_CLOSE = "✕";

// [LAW:single-enforcer] THE display rule every multi-state trigger obeys: one
// display per member, or ONE static display shown in every state.
export function cycleDisplayIssue(
  subject: string,
  count: number,
  members: number,
): string | undefined {
  if (count === 0) return `${subject} needs a display (the clickable text)`;
  if (count !== 1 && count !== members) {
    return `${subject} cycles ${members} members; bind one display per member (${members}) or one static display, got ${count}`;
  }
  return undefined;
}

// [LAW:dataflow-not-control-flow] Pure function of (bound displays, member index).
export function pickCycleDisplay(
  subject: string,
  displays: readonly string[],
  members: number,
  index: number,
): string {
  const issue = cycleDisplayIssue(subject, displays.length, members);
  if (issue !== undefined) throw new Error(issue);
  return displays.length === 1 ? displays[0]! : displays[index]!;
}

// [LAW:one-source-of-truth] Escaping for DISPLAY text spliced inside a quoted
// `{{ }}` argument; not for a template's own body text, which is source.
export function escapeTemplateLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// [LAW:one-source-of-truth] THE lowering of a disclosure: one trigger segment with
// its body hung on it. The body has no `when` — its openness is `ref`.
export function disclosureNode(
  name: string,
  ref: DisclosureRef,
  body: ContainerNode,
  when?: string,
): SegmentNode {
  return {
    kind: "segment",
    name,
    opens: { ref, body },
    ...(when !== undefined && { when }),
  };
}

// [LAW:single-enforcer][LAW:dataflow-not-control-flow] THE body predicate a
// disclosure implies; nesting is conjunction, hence variadic. The separate first
// ref makes a zero-disclosure gate unrepresentable [LAW:types-are-the-program].
export function disclosureGate(
  first: DisclosureRef,
  ...rest: readonly DisclosureRef[]
): string {
  const terms = [first, ...rest].map(disclosureTerm).join(" ");
  return `{{ and ${terms} }}`;
}

// [LAW:one-source-of-truth] "This disclosure is open" as one term of a predicate.
export function disclosureTerm(ref: DisclosureRef): string {
  return `(eq .${ref.variable} "${escapeTemplateLiteral(ref.member)}")`;
}

// [LAW:single-enforcer] THE trigger template; displays bind closed-first.
export function disclosureTrigger(
  action: string,
  closed: string,
  open: string,
): string {
  return `{{ action "${action}" "${escapeTemplateLiteral(closed)}" "${escapeTemplateLiteral(open)}" }}`;
}

// [LAW:single-enforcer] THE backing `state` var a disclosure key implies.
export function disclosureStateVar(key: string, def: string): VariableDecl {
  return { kind: "state", key, default: def };
}

// [LAW:single-enforcer] THE toggle action: a binary `cycle` ordered closed-first.
export function disclosureCycleAction(key: string, member: string): ActionDecl {
  return { set: key, cycle: [DISCLOSURE_CLOSED, member] };
}
