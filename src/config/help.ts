// [LAW:one-type-per-behavior] A `(?)` is the same binary disclosure as a group,
// differing only in trigger text and body content.
// [LAW:one-way-deps][LAW:one-source-of-truth] Content is a PARAMETER, so bar help
// and CLI help are one set of strings.

import type { ActionDecl } from "./action.js";
import type {
  DisclosureRef,
  LayoutNode,
  SegmentDecl,
  SegmentNode,
  VariableDecl,
} from "./dsl-types.js";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSE,
  disclosureCycleAction,
  disclosureGate,
  disclosureNode,
  disclosureStateVar,
  disclosureTrigger,
} from "./disclosure.js";

// [LAW:one-source-of-truth] The trigger's closed text, one spelling for the bar.
// [LAW:no-silent-failure] Per-state: text is the open-state cue colour cannot flatten.
export const HELP_GLYPH_CLOSED = "(?)";

// The open member of the binary key; the other is the shared CLOSED sentinel.
const HELP_OPEN = "open";

// [LAW:one-source-of-truth] Keyed by final name, the shape every synthesis threads.
export interface HelpArtifacts {
  readonly variables: Record<string, VariableDecl>;
  readonly actions: Record<string, ActionDecl>;
  readonly segments: Record<string, SegmentDecl>;
}

// ONE node, placed as a CELL in an existing row, so closed help costs no row.
// [LAW:one-source-of-truth] Every artifact derives from `name` verbatim, so click
// and open-state cannot address different keys.
// [LAW:dataflow-not-control-flow] `within` gates the trigger; hidden renders no body.
export function declareHelp(
  name: string,
  lines: readonly string[],
  within: readonly DisclosureRef[],
  out: HelpArtifacts,
): SegmentNode {
  const self: DisclosureRef = { variable: name, member: HELP_OPEN };
  out.variables[name] = disclosureStateVar(name, DISCLOSURE_CLOSED);
  out.actions[name] = disclosureCycleAction(name, HELP_OPEN);
  out.segments[name] = {
    template: disclosureTrigger(
      name,
      HELP_GLYPH_CLOSED,
      DISCLOSURE_GLYPH_CLOSE,
    ),
    ...gateOf(within),
  };

  // [LAW:one-source-of-truth] One line is one segment, VERBATIM — no escaping.
  const children = lines.map((line, i): LayoutNode => {
    const lineName = `${name}.${i}`;
    // [LAW:single-enforcer] Openness is the trigger's ref, never a second `when`.
    out.segments[lineName] = { template: line };
    return { kind: "segment", name: lineName };
  });

  return disclosureNode(name, self, {
    kind: "container",
    direction: "horizontal",
    children,
  });
}

// Optional, so a gate over nothing stays unrepresentable.
function gateOf(within: readonly DisclosureRef[]): { when?: string } {
  const [first, ...rest] = within;
  return first === undefined ? {} : { when: disclosureGate(first, ...rest) };
}
