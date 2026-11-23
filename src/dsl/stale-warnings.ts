// [LAW:single-enforcer] THE stale warning: one ⚠ for each pick a session
// holds outside its setting's domain that decided what the drawn frame wears.
// A pick a staged value outranks decided nothing, and a placement the frame
// does not draw decides nothing, so neither reaches here: the fold's answer
// (`DecidedBy`) and the walk say which picks decided.
//
// [LAW:no-silent-failure] The bar still draws — what lies beneath the pick —
// and the ⚠ says so from data: the setting, the spelling it holds, what the
// bar wears instead, and what the setting can hold. The fix is a pick, which
// every setting offers; a save is offered only sometimes, so the message
// never asks for one.

import type { ResolvedDomain } from "../config/option-domain.js";
import { describeControlDomain } from "../config/setting-control.js";
import type { SettingRow } from "../config/setting-table.js";
import { retiredThemeSentence, sampledOneOf } from "../themes/policy.js";

// One pick that decided: its setting, the spelling the session holds, and the
// value the bar wears in its place.
export interface StalePick {
  readonly row: SettingRow;
  readonly raw: string;
  readonly wears: string;
}

export interface StaleWarning {
  readonly kind: "stale";
  readonly key: string;
  readonly setting: string;
  readonly message: string;
}

// What a stale spelling's setting can hold: a retired theme's successor, or
// the domain.
function holds(
  pick: StalePick,
  domains: ReadonlyMap<string, ResolvedDomain>,
): string {
  const retired =
    typeof pick.row.domain === "object" && "themes" in pick.row.domain
      ? retiredThemeSentence(pick.raw)
      : "";
  return retired === ""
    ? `It can hold ${describeControlDomain(pick.row.domain, domains, sampledOneOf)}`
    : retired;
}

// One warning per key, in the order the picks came: a name label draws its
// placement's theme, so a pick can be met twice in one frame.
export function staleWarnings(
  picks: readonly StalePick[],
  domains: () => ReadonlyMap<string, ResolvedDomain>,
): readonly StaleWarning[] {
  // Built when a first warning needs it, once for all of them: a frame with
  // no stale pick never builds it.
  let built: ReadonlyMap<string, ResolvedDomain> | undefined;
  const domainsOnce = () => (built ??= domains());
  return [...new Map(picks.map((p) => [p.row.key, p])).values()].map(
    (pick) => ({
      kind: "stale",
      key: pick.row.key,
      setting: pick.row.name,
      message:
        `Setting ${pick.row.name} holds "${pick.raw}", which it cannot hold, ` +
        `so the bar wears "${pick.wears}". ${holds(pick, domainsOnce())}. ` +
        `Pick it again.`,
    }),
  );
}
