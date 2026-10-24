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

// [LAW:one-source-of-truth] The payload paths the daemon no longer writes:
// path → what to read instead. An `input` reading one would publish its
// default forever [LAW:no-silent-failure], so the loader refuses it. Each hint
// names the bundled variable rather than copying its template, so the two
// cannot drift. A future retirement is one row here.
// brandon-unfiled-3248.8ro6: the payload stores instants; what they say
// relative to now is the draw's.
export const RETIRED_INPUT_PATHS: ReadonlyMap<string, string> = new Map([
  [
    "git.timeSinceCommit",
    'the payload stores the commit\'s date as "git.committedAt" (epoch seconds), and the bundled template variable "git.timeSinceCommit" computes its age at the draw: drop this declaration',
  ],
  [
    "block.etaMinutes",
    'the bundled template variable "block.etaMinutes" computes it at the draw: drop this declaration',
  ],
  [
    "weekly.etaMinutes",
    'the bundled template variable "weekly.etaMinutes" computes it at the draw: drop this declaration',
  ],
]);

// [LAW:one-type-per-behavior] The retired `kind: "git"`, field → what reads it
// now: every git fact is an input over the payload's git lane, which the
// bundled default declares under these names (brandon-unfiled-3248.8ro6). The
// git variable was a second path to the same fact — a subscription pushing a
// six-field subset into boxes, resolving the repo without the session's
// project directory — so it could name a different repo than the bar's own
// git cells did.
const RETIRED_GIT_FIELDS: ReadonlyMap<string, string> = new Map([
  ["branch", 'read ".git.branch" (it reads "detached" off a branch)'],
  ["sha", 'read ".git.sha"'],
  ["dirty", 'read (ne .git.status "clean")'],
  ["ahead", 'read ".git.ahead"'],
  ["behind", 'read ".git.behind"'],
  ["stash", 'read ".git.stash"'],
]);

export function retiredGitKindMessage(
  raw: Readonly<Record<string, unknown>>,
): string {
  const field = typeof raw.field === "string" ? raw.field : undefined;
  const read =
    field !== undefined && RETIRED_GIT_FIELDS.has(field)
      ? RETIRED_GIT_FIELDS.get(field)!
      : `read the bundled input variables "git.branch", "git.sha", "git.status", "git.ahead", "git.behind" or "git.stash"`;
  return `kind "git" is retired: every git fact is an input over the payload's git lane, which the bundled default already declares — drop this declaration and ${read} where it was read, or declare { kind: "input", path: "git.<fact>" } under a name of your own`;
}
