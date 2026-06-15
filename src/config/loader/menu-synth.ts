// [LAW:one-source-of-truth] The menu synthesis pass: the load-side mirror of the
// `{{ menu }}` render helper. A menu is the group-accordion mechanism with its
// trigger living inside an arbitrary user segment rather than a synthesized
// toggle segment — so this emits exactly what group sugar does MINUS the segment
// (the helper IS the trigger): one `state` var per row key (default "closed")
// and one `cycle` action per (row, menu-bearing segment) under the reserved
// `menus.` namespace. Both land in the raw sections so they merge over the
// default and, crucially, so `deriveActionValidators(config.actions)` derives the
// click gate from them through the ONE existing path — a menu toggle is gated
// like every other set, no parallel verb. [LAW:single-enforcer]
//
// Runs in `parseDslConfig` after group synthesis and after every section parsed,
// so the reserved-namespace collision check sees the fully-parsed user sections.
//
// [LAW:types-are-the-program] WHICH segments host a menu is read from the parsed
// AST (`referencedFunctions`), not a source-text scan — robust against whitespace,
// pipelines, and `.menu`/"menu" lookalikes. Detection bare-parses the segment
// template; a parse failure here is treated as "no menu" because the authoritative
// parse error is surfaced loudly by `registerDslConfig` when it compiles the same
// template (so this pass never swallows a real error, it just declines to guess).

import { createEngine } from "@promptctl/go-template-js";
import type { ActionDecl } from "../action.js";
import type { Mutable, ValidateCtx } from "./validate-core.js";
import {
  MENU_CLOSED,
  MENU_NS,
  forEachSegmentPlacement,
  menuActionName,
  menuStateKey,
} from "../menu-keys.js";
import type { RawDslConfig, VariableDecl } from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";

// [LAW:single-enforcer] The helper-name a `{{ menu … }}` call uses — the same
// string the render FuncMap registers. A segment "hosts a menu" iff its template
// references this function.
const MENU_FUNC = "menu";

// [LAW:no-defensive-null-guards] A bare engine purely for AST introspection: it
// never evaluates, so `fromString` is identity and no funcs are registered (parse
// does not resolve function existence — that is an eval-time concern).
function segmentReferencesMenu(template: string): boolean {
  const engine = createEngine<string>({ fromString: (s) => s });
  try {
    return engine.parse(template).referencedFunctions().has(MENU_FUNC);
  } catch {
    // A malformed template can host no usable menu; registerDslConfig re-parses
    // and reports the real error. [LAW:no-silent-failure] — not swallowed, just
    // not the place that reports it.
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

  // [LAW:no-silent-failure] A menu derives its accordion identity from its host
  // SEGMENT's tree position; a `{{ define }}` helper is shared and placement-
  // agnostic, so a `{{ menu }}` reached through one has no row to key on and would
  // never get its backing state var/cycle action synthesized — failing at render.
  // Reject it loudly at load, pointing the author to inline the menu in a segment.
  // [LAW:no-mode-explosion] We reject rather than build helper-call-graph
  // resolution speculatively; revisit only if a real shared-menu need appears.
  for (const [name, body] of Object.entries(out.helpers ?? {})) {
    if (segmentReferencesMenu(body)) {
      ctx.issues.push({
        path: `helpers.${name}`,
        message: `helper "${name}" uses {{ menu }}, but a menu must live directly in a segment template — its accordion identity is derived from the segment's position in the layout, which a shared helper does not have. Inline the {{ menu }} call into each segment that needs it.`,
        line: findKeyLine(ctx.source, ["helpers", name]),
      });
    }
  }

  if (out.root === undefined) return;
  const segments = out.segments ?? {};

  // [LAW:dataflow-not-control-flow] Memoize detection by segment name — a segment
  // placed in N rows is parsed once, then each placement reads the cached verdict.
  const hostsMenu = new Map<string, boolean>();
  const referencesMenu = (segName: string): boolean => {
    const cached = hostsMenu.get(segName);
    if (cached !== undefined) return cached;
    const seg = segments[segName];
    const result =
      seg !== undefined ? segmentReferencesMenu(seg.template) : false;
    hostsMenu.set(segName, result);
    return result;
  };

  // One state key per row (default "closed"); one cycle action per (row,segment).
  const stateKeys = new Map<string, string>(); // stateKey → rowKey (for vars)
  const actions: Record<string, ActionDecl> = {};
  forEachSegmentPlacement(out.root, (segName, rowKey) => {
    if (!referencesMenu(segName)) return;
    // [LAW:types-are-the-program] A menu's member name IS its host segment name;
    // a segment named exactly the closed-state sentinel would make the cycle
    // [closed, "closed"] — two identical members, so the toggle could never leave
    // the closed state. Reject that one collision at load (the only segment name
    // that breaks a menu), rather than silently synthesizing an unopenable menu.
    if (segName === MENU_CLOSED) {
      menuIssue(
        ctx,
        `segments.${segName}`,
        `segment "${segName}" hosts a {{ menu }}, but a menu cannot live in a segment named "${MENU_CLOSED}" — that name collides with the menu's closed-state sentinel, leaving the menu unopenable. Rename the segment.`,
      );
      return;
    }
    const stateKey = menuStateKey(rowKey);
    stateKeys.set(stateKey, rowKey);
    // [LAW:one-source-of-truth] Members ordered closed-first: an unset/foreign
    // value counts as the first member (the cycle's "unknown ⇒ first" rule), so a
    // never-clicked menu renders ▸ and a click opens it, auto-closing a row-mate
    // because the shared key can hold only one member name.
    actions[menuActionName(rowKey, segName)] = {
      set: stateKey,
      cycle: [MENU_CLOSED, segName],
    };
  });

  if (stateKeys.size === 0) return;

  const variables: Record<string, VariableDecl> = {};
  for (const stateKey of stateKeys.keys()) {
    variables[stateKey] = {
      kind: "state",
      key: stateKey,
      default: MENU_CLOSED,
    };
  }

  out.variables = { ...(out.variables ?? {}), ...variables };
  out.actions = { ...(out.actions ?? {}), ...actions };
}
