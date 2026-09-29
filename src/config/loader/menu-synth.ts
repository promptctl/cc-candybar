// [LAW:one-source-of-truth] The menu synthesis pass: the load-side mirror of the
// `{{ menu }}` render helper. A menu is the group-accordion mechanism with its
// trigger living inside an arbitrary user segment rather than a synthesized
// toggle segment — so this emits exactly what group sugar does MINUS the segment
// (the helper IS the trigger): one `state` var per menu state key (default
// "closed"), one `cycle` action per (state key, member), AND — bn5.6 — the
// picker body's page cursor (a `state` var + int action named by menuPageKey)
// per state key, all under the reserved `menus.` namespace, so
// `deriveActionValidators(config.actions)` derives the click gates from them
// through the ONE existing path — a menu toggle and its page cursor are gated
// like every other set, no parallel verb. [LAW:single-enforcer]
//
// Two halves, run where each one's facts exist. `checkMenuDecls` runs in
// `parseDslConfig` over what one file wrote: the reservation and every call's
// shape. `synthesizePlacementMenus` runs in `validateConfig` over the trees
// that render, because a menu's key is its PLACEMENT's
// (brandon-segment-settings-i4n).
//
// [LAW:types-are-the-program] WHICH segments host a menu, and with WHAT apply
// action + options, is read from the parsed AST (`referencedCalls` → `argExprs`
// + `staticDictEntries`), not a source-text scan — robust against whitespace,
// pipelines, and `.menu`/"menu" lookalikes, and it yields each call's literal
// apply name and literal `(dict …)` options so a menu's identity (member =
// apply name; key = the optional "key" option) is the SAME fact the render
// helper reads from those same arguments. A parse failure here is treated as
// "no menu" because the authoritative parse error is surfaced loudly by
// `registerDslConfig` when it compiles the same template (so this pass never
// swallows a real error, it just declines to guess).

import {
  createEngine,
  staticDictEntries,
  type ReferencedCall,
} from "@promptctl/go-template-js";
import type { ActionDecl } from "../action.js";
import { fragmentNode } from "../root.js";
import type { ValidateCtx } from "./validate-core.js";
import {
  menuActionName,
  menuMember,
  menuPageKey,
  menuStateKey,
  parseMenuOptions,
  sharedMenuStateKey,
  type MenuOptions,
} from "../menu-keys.js";
import {
  cycleDisplayIssue,
  DISCLOSURE_CLOSED,
  disclosureCycleAction,
  disclosureStateVar,
} from "../disclosure.js";
import {
  placementId,
  walkNodes,
  type DslConfig,
  type RawDslConfig,
  type SegmentNode,
  type VariableDecl,
} from "../dsl-types.js";
import { presetNames, presetRoot } from "../presets.js";
import type { ConfigIssue } from "./diagnostics.js";
import { findKeyLine } from "./diagnostics.js";
import {
  MENU_NS,
  reservedNamespaceCollisions,
  reservedNamespaceOf,
} from "./reserved-namespace.js";

// [LAW:single-enforcer] The helper-name a `{{ menu … }}` call uses — the same
// string the render FuncMap registers. A segment "hosts a menu" iff its template
// references this function.
const MENU_FUNC = "menu";

// [LAW:types-are-the-program] The `{{ menu }}` surface, mirroring the render
// helper's signature `menu "apply" display… [(dict …)]`: the apply name
// (identity member, a required string literal), the trigger's authored display
// text (one per state or one static — the arity is statically countable, so it
// is checked here), and ONE optional trailing options dict — closeOnPick /
// paged / key, all statically readable via `staticDictEntries`. Displays
// themselves are NOT required to be literals; identity does not depend on
// them, exactly as a cycle `{{ action }}`'s displays are free. Every removed
// spelling is rejected with a migration-pointing error, never silently
// reinterpreted [LAW:no-silent-failure].
const MIGRATION = `a menu binds its trigger text the way a cycle action binds a display — write {{ menu "applyTheme" "▸" "▾" }} (one per state) or {{ menu "insertHere" "+" }} (one static display for both), with the rare knobs in ONE trailing dict: {{ menu "applyTheme" "▸" "▾" (dict "closeOnPick" true "paged" false "key" "pickers") }} (defaults: closeOnPick false, paged true, no key). The renderer no longer appends ▸/▾ of its own (candybar-settings-ui-aok.4), and the older positional tail ("pageAction" closeOnPick paged "key") was removed — the page cursor is synthesized from the menu's identity`;

// [LAW:dataflow-not-control-flow] One total analysis of a `{{ menu }}` call site:
// every reachable argument shape lands in exactly one arm — a usable identity
// (apply + parsed options) or one load-error message (the tail after
// `segment "<name>" has a {{ menu }} `). No shape falls through to render time.
type MenuAnalysis =
  | {
      readonly kind: "ok";
      readonly apply: string;
      readonly options: MenuOptions;
    }
  | { readonly kind: "issue"; readonly message: string };

type ArgExpr = ReferencedCall["argExprs"][number];

const isDictCall = (e: ArgExpr): boolean =>
  e.kind === "call" && e.name === "dict";

// [LAW:one-source-of-truth] The two sides split the tail on different evidence —
// exprs here, evaluated values in `parseMenuArgs` — so the loader admits only
// call sites where those two readings PROVABLY coincide. The renderer's split
// asks one question of the last value, "is it an object", so a literal answers
// it here: a parse-time constant evaluates to itself and can never become the
// options dict. A literal `(dict …)` always does. Everything else in that slot
// is classified by whatever it happens to evaluate to.
const isNonObjectLiteral = (e: ArgExpr): boolean =>
  e.kind === "literal" && typeof e.value !== "object";

// The display-arity rule used as a predicate; the message is the caller's
// business, so the subject never surfaces. [LAW:single-enforcer] — legality is
// read off the disclosure primitive, never restated as a count comparison.
const legalDisplayCount = (count: number): boolean =>
  cycleDisplayIssue("", count, 2) === undefined;

function analyzeMenuCall(call: ReferencedCall): MenuAnalysis {
  const issue = (message: string): MenuAnalysis => ({ kind: "issue", message });
  const [applyArg, ...tail] = call.argExprs;
  if (applyArg === undefined) {
    return issue(
      `with no arguments — it takes an apply-action name and its trigger text (e.g. {{ menu "applyTheme" "▸" "▾" }})`,
    );
  }
  if (applyArg.kind !== "literal" || typeof applyArg.value !== "string") {
    return issue(
      `whose apply action is not a string literal — a menu's identity is its apply-action name, which must be a literal so it can be gated at load (e.g. {{ menu "applyTheme" "▸" "▾" }})`,
    );
  }
  // [LAW:types-are-the-program] The dict is the LAST argument when present;
  // everything before it is a display. Splitting on that one position is the
  // whole grammar, and it is the same split `parseMenuArgs` performs on the
  // evaluated tail at render — one shape, read twice from the two things each
  // side has (exprs here, values there).
  const last = tail[tail.length - 1];
  const optsArg = last !== undefined && isDictCall(last) ? last : undefined;
  const displays = optsArg === undefined ? tail : tail.slice(0, -1);
  if (displays.some(isDictCall)) {
    return issue(
      `whose options (dict …) is not its last argument — ${MIGRATION}`,
    );
  }
  // [LAW:no-silent-failure] The last slot is the one both readings can claim.
  // When the expr there is not provably one or the other AND dropping it still
  // leaves a legal display count, the renderer's value-based split can land on
  // a DIFFERENT reading than this one — same call, two shapes, no error either
  // side: the options dict skips `staticDictEntries` (so a dynamic `key` derives
  // a state key with no synthesized var behind it, and the menu never opens) or
  // a display vanishes into the static form. Reject that call site; an explicit
  // trailing `(dict …)` disambiguates it and keeps dynamic displays legal.
  // Where the alternate reading is an ILLEGAL count the renderer throws instead
  // of diverging, so it stays accepted — loudness, not refusal, is the bar.
  if (
    last !== undefined &&
    optsArg === undefined &&
    !isNonObjectLiteral(last) &&
    legalDisplayCount(displays.length - 1)
  ) {
    return issue(
      `whose last argument is neither a literal nor a literal (dict …) — the renderer tells a display from the options dict by the value it evaluates to, so this call could be read as ${displays.length} displays or as ${displays.length - 1} plus options, and both are legal. Make the options explicit as a trailing (dict …) — {{ menu "${applyArg.value}" (printf "…") (printf "…") (dict) }} binds dynamic displays unambiguously — or bind the trigger text as literals`,
    );
  }
  // [LAW:single-enforcer] The display-arity rule is the disclosure primitive's,
  // the same one the renderer picks through — checked HERE too because the
  // count is statically known, so an unauthored trigger is a load error naming
  // the fix rather than a diagnostic glyph on the next render.
  // "whose trigger …" completes the caller's `segment "X" has a {{ menu }} `.
  const arity = cycleDisplayIssue("whose trigger", displays.length, 2);
  if (arity !== undefined) return issue(`${arity} — ${MIGRATION}`);
  const entries = optsArg === undefined ? {} : staticDictEntries(optsArg);
  if (entries === null) {
    return issue(
      `whose options (dict …) is not fully literal — every option value must be a literal so the menu can be gated at load (a dynamic entry like (dict "key" .x) cannot)`,
    );
  }
  let options: MenuOptions;
  try {
    options = parseMenuOptions(entries);
  } catch (e) {
    return issue(`with invalid options — ${(e as Error).message}`);
  }
  // [LAW:no-silent-failure] An accordion key is the one authored name that never
  // becomes a declaration, so `reservedNamespaceCollisions` cannot see it — and
  // `menuStateKey` collapses it through `ident()`, which is where a reserved
  // namespace leaks: every spelling of `settings.pickers` collapses to the state
  // key the settings menu's picker accordion mints, and a shared key joining an
  // accordion is the mechanism BY DESIGN, so the join was silent (brandon-menus-du8).
  // Gated here, at load, because this pass sees exactly the AUTHORED menus: the
  // settings menu synthesizes its own artifacts in `validateConfig`, after this
  // pass has run, so its own reserved key is never asked to pass its own gate.
  // The render side re-reads these options but re-checks nothing — a config that
  // loaded holds no reserved key [LAW:parse-dont-validate].
  const sharedKey = options.key;
  if (sharedKey !== undefined) {
    const reserved = reservedNamespaceOf(sharedKey);
    if (reserved !== undefined) {
      return issue(
        `whose accordion key "${sharedKey}" lands in the reserved "${reserved}" namespace — ` +
          `a key is collapsed to an identifier (${JSON.stringify(sharedKey)} becomes ` +
          `"${sharedMenuStateKey(sharedKey)}"), so it would share one open-state key with the ` +
          `synthesized accordion that owns that namespace instead of grouping only your own menus. ` +
          `Name the group without the reserved prefix`,
      );
    }
  }
  return { kind: "ok", apply: applyArg.value, options };
}

// [LAW:no-defensive-null-guards] A bare engine purely for AST introspection: it
// never evaluates, so `fromString` is identity and no funcs are registered (parse
// does not resolve function existence — that is an eval-time concern).
function parseCalls(
  template: string,
): readonly MenuAnalysis[] | "parse-failed" {
  const engine = createEngine<string>({ fromString: (s) => s });
  try {
    return engine
      .parse(template)
      .referencedCalls()
      .filter((c) => c.name === MENU_FUNC)
      .map(analyzeMenuCall);
  } catch {
    // A malformed template can host no usable menu; registerDslConfig re-parses
    // and reports the real error. [LAW:no-silent-failure] — not swallowed, just
    // not the place that reports it.
    return "parse-failed";
  }
}

// [LAW:single-enforcer] THE "does this segment host a menu" predicate — read
// from the parsed AST, shared with cross-ref's placement-count check.
export function segmentReferencesMenu(template: string): boolean {
  const engine = createEngine<string>({ fromString: (s) => s });
  try {
    return engine.parse(template).referencedFunctions().has(MENU_FUNC);
  } catch {
    return false;
  }
}

function menuIssue(ctx: ValidateCtx, path: string, message: string): void {
  ctx.issues.push({ path, message, line: findKeyLine(ctx.source, ["root"]) });
}

export function checkMenuDecls(
  ctx: ValidateCtx,
  out: Readonly<RawDslConfig>,
): void {
  // [LAW:single-enforcer] The `menus.` namespace is reserved UNCONDITIONALLY — a
  // user name under it is rejected whether or not any menu is placed this load, so
  // the reservation is a stable contract ("you never author menus.*"), not a rule
  // that only switches on when synthesis happens to collide. Runs before any early
  // return so a `menus.*` user name can never load silently. The check is the
  // disclosure primitive's shared enforcer (mirroring group sugar's `groups.`).
  reservedNamespaceCollisions(ctx, out, MENU_NS, "{{ menu }} helpers");

  // [LAW:no-silent-failure] A menu derives its identity from the SEGMENT it sits
  // in (the published segment name) plus its own apply arg; a `{{ define }}`
  // helper is shared across segments, so the synthesis pass — which scans each
  // segment's own template — cannot see a menu reached only through `{{ template
  // }}` and would never synthesize its backing state var/cycle action, failing at
  // render. Reject it loudly at load, pointing the author to inline the menu.
  // [LAW:no-mode-explosion] We reject rather than resolve the helper call graph
  // speculatively; revisit only if a real shared-menu need appears.
  for (const [name, body] of Object.entries(out.helpers ?? {})) {
    if (segmentReferencesMenu(body)) {
      ctx.issues.push({
        path: `helpers.${name}`,
        message: `helper "${name}" uses {{ menu }}, but a menu must live directly in a segment template — its identity is derived from the segment it sits in, which a shared helper does not have. Inline the {{ menu }} call into each segment that needs it.`,
        line: findKeyLine(ctx.source, ["helpers", name]),
      });
    }
  }

  const segments = out.segments ?? {};

  // [LAW:locality-or-seam] A menu publishes its placement ONLY around the segment
  // `template` eval; bg/fg evaluate after that window and a node/segment `when`
  // before it, so a {{ menu }} in any of them throws at render. The template is
  // the menu's one valid seam — reject it anywhere else at load, rather than
  // admit a config that parses but crashes on render.
  for (const [segName, seg] of Object.entries(segments)) {
    for (const field of ["bg", "fg", "when"] as const) {
      const tpl = seg[field];
      if (typeof tpl === "string" && segmentReferencesMenu(tpl)) {
        menuIssue(
          ctx,
          `segments.${segName}.${field}`,
          `segment "${segName}" uses {{ menu }} in its "${field}" — a menu is only valid in a segment's "template" (its placement is published only there; "${field}" needs a ${field === "when" ? "predicate" : "color"}). Move the {{ menu }} into the template.`,
        );
      }
    }
  }

  // Reject {{ menu }} in node `when` predicates (same template-only rule).
  // The placement-count check (a menu host placed twice) lives in cross-ref,
  // over the tree that RENDERS — a `{ rows }` fragment and a row it inherits
  // can each place one, which this single raw file cannot see.
  if (out.root !== undefined) {
    for (const node of walkNodes(fragmentNode(out.root))) {
      if (typeof node.when === "string" && segmentReferencesMenu(node.when)) {
        menuIssue(
          ctx,
          "root",
          `a layout node's "when" predicate uses {{ menu }} — a menu is only valid in a segment's "template", not a node predicate. Move it into a segment.`,
        );
      }
    }
  }

  // [LAW:no-silent-failure] Every call's SHAPE is the segment's own fact, so
  // it is checked here, where the author wrote it. The keys a call derives
  // are a fact about each PLACEMENT, so they are minted after merge
  // (synthesizePlacementMenus below), over the trees that render.
  for (const [segName, { template }] of Object.entries(segments)) {
    // A delta inheriting its template declares no menus of its own: the
    // bundled template's were checked when the bundled default parsed.
    if (template === undefined || !segmentReferencesMenu(template)) continue;
    const calls = parseCalls(template);
    if (calls === "parse-failed") continue;
    for (const call of calls) {
      const message =
        call.kind === "issue" ? call.message : identityIssue(call.apply);
      if (message !== undefined) {
        menuIssue(
          ctx,
          `segments.${segName}`,
          `segment "${segName}" has a {{ menu }} ${message}.`,
        );
      }
    }
  }
}

// [LAW:types-are-the-program] The two apply names that cannot be a member. An
// empty one aliases the absent-state sentinel ("") — the store reads "" for an
// unset key, so `open = read === member` would hold before any click. One
// equal to the closed sentinel makes the cycle [closed, "closed"], leaving the
// menu unopenable.
function identityIssue(apply: string): string | undefined {
  if (apply === "") {
    return `with an empty apply-action name — an empty member aliases the absent-state sentinel ("") so the menu would render open before any click. Name the apply action`;
  }
  if (menuMember(apply) === DISCLOSURE_CLOSED) {
    return `whose apply action is named "${DISCLOSURE_CLOSED}", which collides with the menu's closed-state sentinel and leaves it unopenable. Rename the action`;
  }
  return undefined;
}

// [LAW:one-source-of-truth] The keys every PLACEMENT's menus read and write
// (brandon-segment-settings-i4n): one `state` var per state key (default
// "closed"), one cycle action per (state key, member), and one page cursor per
// state key — minted over every tree a preset renders, since a menu's
// identity is its placement's id, not its segment's name. Two placements of
// one menu-hosting segment therefore open independently, and a bare
// placement, whose id is its segment's name, derives the key it always did.
// Everything lands in the config's own sections, so
// `deriveActionValidators(config.actions)` derives the click gates through
// the ONE existing path [LAW:single-enforcer].
//
// Runs from validateConfig once cross-ref has proved every placement names a
// declared segment and every id is unique in its tree; the issues it finds
// are key collisions only a merged, placed config can have.
export function synthesizePlacementMenus(
  config: DslConfig,
  issues: ConfigIssue[],
): DslConfig {
  const variables: Record<string, VariableDecl> = {};
  const actions: Record<string, ActionDecl> = {};
  // [LAW:types-are-the-program] A synthesized key is `ident()`-normalized so
  // it carries no separators; that normalization is lossy (`a-b` and `a_b`
  // collapse), so two DISTINCT declarations could map to one key and silently
  // share state (an unintended accordion). Track the raw "owner" each
  // synthesized name (state key AND its derived page key) legitimately belongs
  // to — a shared key is owned by its raw key string (every sibling agrees);
  // an independent menu by its raw (placement, apply). A second owner on the
  // same name is a collision, rejected so it is unrepresentable
  // [LAW:no-silent-failure] rather than corrupting grouping. Registering the
  // page key too closes the cross-shape aliasing corner (e.g. an apply action
  // named "page" in placement "s" vs the page cursor of a shared key "s").
  const ownerBySynthKey = new Map<string, string>();
  // Two menus claiming one identity (same key + same member) cannot be
  // addressed distinctly: for independent menus that is the literal same
  // `{{ menu }}` twice in a segment; for shared-key menus it is two menus with
  // the same apply name sharing a key.
  const claimed = new Set<string>();
  const issue = (segName: string, message: string): void => {
    issues.push({ path: `segments.${segName}`, message });
  };
  // One placement that renders in several presets is one placement: its menus
  // are minted once.
  const placements = new Map<string, SegmentNode>();
  for (const name of presetNames(config.presets)) {
    for (const node of walkNodes(presetRoot(config, name).node)) {
      if (node.kind !== "segment") continue;
      placements.set(`${placementId(node)}\0${node.name}`, node);
    }
  }
  for (const node of placements.values()) {
    const seg = config.segments[node.name];
    if (seg === undefined || !segmentReferencesMenu(seg.template)) continue;
    const calls = parseCalls(seg.template);
    if (calls === "parse-failed") continue;
    const id = placementId(node);
    for (const call of calls) {
      if (call.kind === "issue" || identityIssue(call.apply) !== undefined) {
        continue;
      }
      const { apply, options } = call;
      const member = menuMember(apply);
      const stateKey = menuStateKey(id, apply, options.key);
      const pageKey = menuPageKey(stateKey);
      const owner =
        options.key !== undefined ? `key ${options.key}` : `ind ${id} ${apply}`;
      const clashKey = [stateKey, pageKey].find((k) => {
        const prior = ownerBySynthKey.get(k);
        return prior !== undefined && prior !== owner;
      });
      if (clashKey !== undefined) {
        issue(
          node.name,
          `two {{ menu }} disclosures normalize to the same state key ("${clashKey}") but were declared differently — distinct names that differ only by non-alphanumeric characters (e.g. "a-b" vs "a_b") collapse to one key and would silently share open-state. Rename so they don't collide.`,
        );
        continue;
      }
      ownerBySynthKey.set(stateKey, owner);
      ownerBySynthKey.set(pageKey, owner);
      const identity = menuActionName(stateKey, member);
      if (claimed.has(identity)) {
        issue(
          node.name,
          `two {{ menu }} disclosures resolve to the same identity ("${identity}") — ${
            options.key !== undefined
              ? `menus sharing key "${options.key}" must have distinct apply actions`
              : `a segment cannot contain two menus over the same apply action "${apply}"`
          }.`,
        );
        continue;
      }
      claimed.add(identity);
      // [LAW:one-source-of-truth] The shared disclosure toggle: members
      // ordered closed-first (an unset/foreign value counts as the first
      // member — the cycle's "unknown ⇒ first" rule — so a never-clicked menu
      // renders ▸ and a click opens it; a shared key holding one member
      // auto-closes its siblings).
      actions[identity] = disclosureCycleAction(stateKey, member);
      variables[stateKey] = disclosureStateVar(stateKey, DISCLOSURE_CLOSED);
      // [LAW:one-source-of-truth] The synthesized page cursor — the half a
      // blind author used to hand-declare and forget, silently freezing the
      // picker on page 0. Both halves are emitted together, named by
      // menuPageKey, so the pairing is a construction, not a convention: the
      // state VAR is what the renderer reads the live page through; the int
      // ACTION is what deriveActionValidators derives the ←/→/✕ wire gate
      // from — the one existing path, no parallel gate [LAW:single-enforcer].
      variables[pageKey] = { kind: "state", key: pageKey, default: "0" };
      actions[pageKey] = { set: pageKey, int: true };
    }
  }
  return {
    ...config,
    variables: { ...config.variables, ...variables },
    actions: { ...config.actions, ...actions },
  };
}
