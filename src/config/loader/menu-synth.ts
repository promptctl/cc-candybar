// [LAW:one-source-of-truth] The menu synthesis pass: the load-side mirror of the
// `{{ menu }}` render helper. A menu is the group-accordion mechanism with its
// trigger living inside an arbitrary user segment rather than a synthesized
// toggle segment — so this emits exactly what group sugar does MINUS the segment
// (the helper IS the trigger): one `state` var per menu state key (default
// "closed") and one `cycle` action per (state key, member) under the reserved
// `menus.` namespace. Both land in the raw sections so they merge over the
// default and, crucially, so `deriveActionValidators(config.actions)` derives the
// click gate from them through the ONE existing path — a menu toggle is gated
// like every other set, no parallel verb. [LAW:single-enforcer]
//
// Runs in `parseDslConfig` after group synthesis and after every section parsed,
// so the reserved-namespace collision check sees the fully-parsed user sections.
//
// [LAW:types-are-the-program] WHICH segments host a menu, and with WHAT apply
// action + optional shared key, is read from the parsed AST (`referencedCalls`),
// not a source-text scan — robust against whitespace, pipelines, and
// `.menu`/"menu" lookalikes, and it yields each call's literal string arguments
// so a menu's identity (member = apply name; key = optional shared key) is the
// SAME fact the render helper reads from those same argument positions. A parse
// failure here is treated as "no menu" because the authoritative parse error is
// surfaced loudly by `registerDslConfig` when it compiles the same template (so
// this pass never swallows a real error, it just declines to guess).

import { createEngine } from "@promptctl/go-template-js";
import type { ActionDecl } from "../action.js";
import type { Mutable, ValidateCtx } from "./validate-core.js";
import {
  MENU_CLOSED,
  MENU_NS,
  menuActionName,
  menuMember,
  menuStateKey,
} from "../menu-keys.js";
import type { RawDslConfig, VariableDecl } from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";

// [LAW:single-enforcer] The helper-name a `{{ menu … }}` call uses — the same
// string the render FuncMap registers. A segment "hosts a menu" iff its template
// references this function.
const MENU_FUNC = "menu";

// [LAW:types-are-the-program] The `{{ menu }}` argument positions, mirroring the
// render helper's signature `menu apply page closeOnPick paged key`. Only the
// apply name (identity member) and the optional shared key (accordion grouping)
// affect synthesis; page/closeOnPick/paged are render-only and ignored here.
const ARG_APPLY = 0;
const ARG_KEY = 4;

// [LAW:types-are-the-program] One menu call's identity-bearing arguments. Each
// arg has three states the synthesis must tell apart: a literal string (usable),
// `null` (a slot present but non-literal — its value is eval-time, so it cannot
// be gated at load → author error), and `undefined` (the slot was omitted). The
// apply slot is required; the key slot is optional (undefined ⇒ independent menu).
interface MenuCall {
  readonly apply: string | null;
  readonly key: string | null | undefined;
}

// [LAW:no-defensive-null-guards] A bare engine purely for AST introspection: it
// never evaluates, so `fromString` is identity and no funcs are registered (parse
// does not resolve function existence — that is an eval-time concern).
function parseCalls(template: string): readonly MenuCall[] | "parse-failed" {
  const engine = createEngine<string>({ fromString: (s) => s });
  try {
    return engine
      .parse(template)
      .referencedCalls()
      .filter((c) => c.name === MENU_FUNC)
      .map((c) => ({
        apply: c.args[ARG_APPLY] ?? null,
        // `referencedCalls` reports an omitted positional slot as absent and a
        // present non-literal as null; preserve that distinction.
        key: c.args.length > ARG_KEY ? c.args[ARG_KEY] : undefined,
      }));
  } catch {
    // A malformed template can host no usable menu; registerDslConfig re-parses
    // and reports the real error. [LAW:no-silent-failure] — not swallowed, just
    // not the place that reports it.
    return "parse-failed";
  }
}

function segmentReferencesMenu(template: string): boolean {
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

export function synthesizeMenuDecls(
  ctx: ValidateCtx,
  out: Mutable<RawDslConfig>,
): void {
  // [LAW:single-enforcer] The `menus.` namespace is reserved UNCONDITIONALLY — a
  // user name under it is rejected whether or not any menu is placed this load, so
  // the reservation is a stable contract ("you never author menus.*"), not a rule
  // that only switches on when synthesis happens to collide. Runs before any early
  // return so a `menus.*` user name can never load silently.
  for (const section of ["variables", "actions", "segments"] as const) {
    for (const name of Object.keys(out[section] ?? {})) {
      if (name.startsWith(MENU_NS)) {
        menuIssue(
          ctx,
          `${section}.${name}`,
          `"${name}" is in the reserved "${MENU_NS}" namespace (synthesized by {{ menu }} helpers) — rename it`,
        );
      }
    }
  }

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

  // One state var per state key (default "closed"); one cycle action per
  // (stateKey, member). [LAW:dataflow-not-control-flow] Independent menus each
  // contribute their own key; shared-key menus contribute distinct members to one
  // key, and the same-key validator merge unions them into one accordion gate.
  const stateKeys = new Set<string>();
  const actions: Record<string, ActionDecl> = {};
  // Guard against two menus claiming one identity (same key + same member): for
  // independent menus that means the literal same `{{ menu }}` twice in a
  // segment; for shared-key menus it means two menus with the same apply name
  // sharing a key — neither can be addressed distinctly, so reject.
  const claimed = new Set<string>();
  // [LAW:types-are-the-program] The state key is `ident()`-normalized so it carries
  // no separators; that normalization is lossy (`a-b` and `a_b` collapse), so two
  // DISTINCT declarations could map to one key and silently share open-state (an
  // unintended accordion). Track the raw "owner" each key legitimately belongs to
  // — a shared key is owned by its raw key string (every sibling agrees); an
  // independent menu by its raw (segment, apply). A second owner on the same key
  // is a normalization collision, rejected at load so it is unrepresentable
  // [LAW:no-silent-failure] rather than corrupting grouping.
  const ownerByStateKey = new Map<string, string>();

  for (const [segName, seg] of Object.entries(segments)) {
    if (!segmentReferencesMenu(seg.template)) continue;
    const calls = parseCalls(seg.template);
    if (calls === "parse-failed") continue;
    for (const call of calls) {
      if (call.apply === null) {
        menuIssue(
          ctx,
          `segments.${segName}`,
          `segment "${segName}" has a {{ menu }} whose apply action is not a string literal — a menu's identity is its apply-action name, which must be a literal so it can be gated at load (e.g. {{ menu "applyTheme" "themePage" }}).`,
        );
        continue;
      }
      if (call.key === null) {
        menuIssue(
          ctx,
          `segments.${segName}`,
          `segment "${segName}" has a {{ menu }} whose accordion key is not a string literal — a shared key must be a literal so the mutually-exclusive group can be gated at load (e.g. {{ menu "applyTheme" "themePage" false false "pickers" }}).`,
        );
        continue;
      }
      // [LAW:types-are-the-program] An empty shared key collapses the state key to
      // the bare reserved `menus.` namespace (and a `menus..member` action name).
      // Reject it — a shared key, when present, must name a group.
      if (call.key === "") {
        menuIssue(
          ctx,
          `segments.${segName}`,
          `segment "${segName}" has a {{ menu }} with an empty accordion key — a shared key must be a non-empty name (or omit it for an independent menu).`,
        );
        continue;
      }
      // [LAW:types-are-the-program] An empty apply name → empty member, and the
      // store returns "" for an absent state key, so `open = read === member`
      // would be true before any click — the menu would render open spuriously.
      // Reject it (the member must never alias the absent-state sentinel).
      if (call.apply === "") {
        menuIssue(
          ctx,
          `segments.${segName}`,
          `segment "${segName}" has a {{ menu }} with an empty apply-action name — an empty member aliases the absent-state sentinel ("") so the menu would render open before any click. Name the apply action.`,
        );
        continue;
      }
      const member = menuMember(call.apply);
      // [LAW:types-are-the-program] A member equal to the closed sentinel makes
      // the cycle [closed, "closed"] — two identical members, leaving the menu
      // unopenable. The only apply name that breaks a menu; reject it at load.
      if (member === MENU_CLOSED) {
        menuIssue(
          ctx,
          `segments.${segName}`,
          `segment "${segName}" has a {{ menu }} whose apply action is named "${MENU_CLOSED}", which collides with the menu's closed-state sentinel and leaves it unopenable. Rename the action.`,
        );
        continue;
      }
      const stateKey = menuStateKey(segName, call.apply, call.key);
      // The raw declaration this key legitimately belongs to. Shared-key siblings
      // all share one owner (their raw key); an independent menu owns its key alone
      // (its raw segment+apply, NUL-joined so the two parts can't run together).
      const owner =
        call.key !== undefined
          ? `key ${call.key}`
          : `ind ${segName} ${call.apply}`;
      const priorOwner = ownerByStateKey.get(stateKey);
      if (priorOwner !== undefined && priorOwner !== owner) {
        menuIssue(
          ctx,
          `segments.${segName}`,
          `two {{ menu }} disclosures normalize to the same state key ("${stateKey}") but were declared differently — distinct names that differ only by non-alphanumeric characters (e.g. "a-b" vs "a_b") collapse to one key and would silently share open-state. Rename so they don't collide.`,
        );
        continue;
      }
      ownerByStateKey.set(stateKey, owner);
      const identity = menuActionName(stateKey, member);
      if (claimed.has(identity)) {
        menuIssue(
          ctx,
          `segments.${segName}`,
          `two {{ menu }} disclosures resolve to the same identity ("${identity}") — ${
            call.key !== undefined
              ? `menus sharing key "${call.key}" must have distinct apply actions`
              : `a segment cannot contain two menus over the same apply action "${call.apply}"`
          }.`,
        );
        continue;
      }
      claimed.add(identity);
      stateKeys.add(stateKey);
      // [LAW:one-source-of-truth] Members ordered closed-first: an unset/foreign
      // value counts as the first member (the cycle's "unknown ⇒ first" rule), so
      // a never-clicked menu renders ▸ and a click opens it; a shared key holding
      // one member auto-closes its siblings.
      actions[identity] = { set: stateKey, cycle: [MENU_CLOSED, member] };
    }
  }

  if (stateKeys.size === 0) return;

  const variables: Record<string, VariableDecl> = {};
  for (const stateKey of stateKeys) {
    variables[stateKey] = {
      kind: "state",
      key: stateKey,
      default: MENU_CLOSED,
    };
  }

  out.variables = { ...(out.variables ?? {}), ...variables };
  out.actions = { ...(out.actions ?? {}), ...actions };
}
