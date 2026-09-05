// [LAW:one-type-per-behavior] candybar-settings-ui-aok.6 — the `(?)` affordance.
// It is NOT a fourth kind of disclosure. A `(?)` is the SAME binary toggle
// `kind: "group"`, `{{ menu }}`, edit mode's trigger and the global settings menu
// all are; it differs from a group in exactly two VALUES — the text its trigger
// binds (`(?)`/`✕` rather than `label ▸`/`label ▾`) and what its body contains
// (help lines rather than arbitrary layout). So every artifact below comes out
// of `disclosure.ts`, and this module contributes no state, no gate, and no
// glyph rule of its own — only the two values and the shape they fill.
//
// The ticket that asked for this predicted the alternative: "if it arrives as
// another hand-rolled set of four artifacts, the finding to report is that the
// disclosure itself wants to be one thing". It did. `disclosure.ts` had
// single-sourced only the two artifacts that are DATA (the state var, the cycle
// action) and left the two that are STRINGS — the trigger template and the body
// gate — hand-written at five sites, which is where the `+▸` double-glyph bug of
// .4 lived. `disclosureTrigger`/`disclosureGate` finish that extraction, and
// this file is the first caller that never had a copy to begin with.
//
// [LAW:one-way-deps] Content is a PARAMETER, never an import: this module knows
// how to mint a help disclosure and nothing about what any particular one says.
// The bundled sentences live in `src/help-text.ts` — the corpus `--help` prints
// — and the two synthesis passes that place a `(?)` pass them in. That is what
// keeps the bar's help and the CLI's help one set of strings rather than two
// hand-maintained copies [LAW:one-source-of-truth].

import type { ActionDecl } from "./action.js";
import type { LayoutNode, SegmentDecl, VariableDecl } from "./dsl-types.js";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSE,
  disclosureCycleAction,
  disclosureGate,
  disclosureStateVar,
  disclosureTrigger,
  type DisclosureRef,
} from "./disclosure.js";

// [LAW:one-source-of-truth] The trigger's closed text, one spelling for the
// whole bar so a reader learns the affordance once. Its OPEN text is the shared
// `DISCLOSURE_GLYPH_CLOSE` — the same ✕ a picker's close cell and edit mode's
// opened `+` wear, because it is the same meaning: click to close what this
// opened.
//
// [LAW:no-silent-failure] Deliberately per-state rather than one static `(?)`.
// Several `(?)` triggers can be visible at once (edit mode's and the config
// menu's, whenever both surfaces are open). An open one does wear its band's
// state colour (node-registry picks `styles.trigger` whenever a segment has
// drops, authored bg or not), but colour is a hint the terminal's colour depth
// may flatten; the trigger's own text is the one place the open state can
// always be read, exactly as it is for the `+` beside it.
export const HELP_GLYPH_CLOSED = "(?)";

// The open member of a help disclosure's binary key: it holds this or the shared
// CLOSED sentinel, like every other binary disclosure in the bar.
const HELP_OPEN = "open";

// [LAW:one-source-of-truth] The declarations a `(?)` contributes, keyed by final
// name — the same accumulator shape `ChromeArtifacts`/`MenuArtifacts` already
// thread through their synthesis passes, so a caller merges one more set of
// artifacts the way it already merges its own.
export interface HelpArtifacts {
  readonly variables: Record<string, VariableDecl>;
  readonly actions: Record<string, ActionDecl>;
  readonly segments: Record<string, SegmentDecl>;
}

// [LAW:types-are-the-program] The two nodes a caller must place, returned
// separately because they belong in different rows and only the caller knows
// which: the trigger is a CELL that joins a row the caller already has (so
// opening help never widens the bar and closed help costs no row), and the body
// is a ROW of its own that exists only while the disclosure is open.
export interface HelpDisclosure {
  readonly trigger: LayoutNode;
  readonly body: LayoutNode;
}

// Mint one `(?)` and its body.
//
// `name` is the reserved-namespace base every artifact derives from — the
// trigger segment, the state variable and the cycle action all take it
// verbatim, the same one-name-four-artifacts convention `groups.<name>` and
// `settings.menu` already use, so the toggle's click and the body's gate cannot
// address different keys [LAW:one-source-of-truth].
//
// `within` names the disclosures this help sits INSIDE (edit mode, the settings
// menu). Both nodes inherit those gates, so a `(?)` opened inside a surface that
// is then closed cannot leave its body stranded on the bar — the body's gate is
// its own ref AND every enclosing one, which is what "open" actually means for a
// nested disclosure [LAW:dataflow-not-control-flow].
export function declareHelp(
  name: string,
  lines: readonly string[],
  within: readonly DisclosureRef[],
  out: HelpArtifacts,
  text?: { readonly fg: string },
): HelpDisclosure {
  const self: DisclosureRef = { variable: name, member: HELP_OPEN };
  out.variables[name] = disclosureStateVar(name, DISCLOSURE_CLOSED);
  out.actions[name] = disclosureCycleAction(name, HELP_OPEN);
  out.segments[name] = {
    template: disclosureTrigger(
      name,
      HELP_GLYPH_CLOSED,
      DISCLOSURE_GLYPH_CLOSE,
    ),
    ...text,
    // The trigger is visible wherever its host surface is. An unnested `(?)`
    // (`within` empty) is always visible, and declares no `when` at all.
    ...gateOf(within),
  };

  // [LAW:one-source-of-truth] One line is one SEGMENT whose template is that
  // line VERBATIM — no wrapper text, no joining, no reformatting, and no
  // escaping. A `template` IS template source, so its static runs reach the bar
  // unchanged; escaping belongs to text spliced INSIDE a quoted `{{ }}` argument
  // (what `disclosureTrigger` above does, and this is not), and applying it here
  // would put backslashes on the bar the moment a sentence used a quote. That is
  // what makes "the bar's help IS the corpus" checkable as identity rather than
  // as string similarity: the declaration a test reads and the sentence
  // `src/help-text.ts` exports are one value, byte for byte.
  const bodyGate = disclosureGate(self, ...within);
  const children = lines.map((line, i): LayoutNode => {
    const lineName = `${name}.${i}`;
    // [LAW:single-enforcer] The gate lives on the body container below and
    // nowhere else — the render walk ANDs an ancestor's `when` into every
    // descendant (src/dsl/render.ts:764), so a copy here would be a second
    // enforcer of one predicate with nothing keeping the two equal.
    out.segments[lineName] = { template: line, ...text };
    return { kind: "segment", name: lineName };
  });

  return {
    trigger: { kind: "segment", name },
    body: {
      kind: "container",
      direction: "horizontal",
      children,
      when: bodyGate,
    },
  };
}

// The enclosing gate as an optional `when` field — the codebase's standard
// spelling for "this field exists only when there is something to put in it",
// keeping `disclosureGate`'s first argument required so a gate over nothing
// stays unrepresentable.
function gateOf(within: readonly DisclosureRef[]): { when?: string } {
  const [first, ...rest] = within;
  return first === undefined ? {} : { when: disclosureGate(first, ...rest) };
}
