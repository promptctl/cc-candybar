// [LAW:one-source-of-truth] The bundled variables that became per-placement
// settings: old variable name → the segment and setting that replaced it. A
// user file merges on top of the bundled default, so a file that still
// declares one would declare a variable nothing reads — its value silently
// ignored. The loader refuses it instead [LAW:no-silent-failure], with the
// placement setting to write. A future retirement is one row here.
// A Map, not an object literal: an authored name is user data.
export const RETIRED_VARIABLES: ReadonlyMap<
  string,
  { readonly segment: string; readonly setting: string }
> = new Map([
  // brandon-settings-coverage-g4p.lx2
  ["session.budget.amount", { segment: "session", setting: "budget" }],
  [
    "session.budget.warningThreshold",
    { segment: "session", setting: "warnAt" },
  ],
  ["today.budget.amount", { segment: "today", setting: "budget" }],
  ["today.budget.warningThreshold", { segment: "today", setting: "warnAt" }],
  ["block.budget.heatThreshold", { segment: "block", setting: "warnAt" }],
  ["block.budget.warningThreshold", { segment: "block", setting: "errorAt" }],
  ["weekly.budget.heatThreshold", { segment: "weekly", setting: "warnAt" }],
  ["weekly.budget.warningThreshold", { segment: "weekly", setting: "errorAt" }],
  ["burn.eta.errorMinutes", { segment: "burnrate", setting: "errorWithin" }],
  ["burn.eta.warnMinutes", { segment: "burnrate", setting: "warnWithin" }],
]);

// Where the retired value lives now — one spelling for both ways a file can
// still name it: declaring the variable, or reading it in a template.
function replacement(to: {
  readonly segment: string;
  readonly setting: string;
}): string {
  return `it became the "${to.setting}" setting of each "${to.segment}" placement — set it on the placement where a row places "${to.segment}" ({ seg: "${to.segment}", settings: { ${to.setting}: <value> } }), or redeclare segments.${to.segment}.settings.${to.setting} with the default every placement should start from`;
}

export function retiredVariableMessage(name: string): string | undefined {
  const to = RETIRED_VARIABLES.get(name);
  return to === undefined
    ? undefined
    : `variables.${name} is no longer read: ${replacement(to)}`;
}

// A template READ of a retired name: the same replacement, plus the read a
// "<segment>" template writes instead.
export function retiredReadHint(ref: string): string {
  const to = RETIRED_VARIABLES.get(ref);
  return to === undefined
    ? ""
    : ` — ".${ref}" is no longer a variable: ${replacement(to)}; a "${to.segment}" template reads it as ".settings.${to.setting}"`;
}
