// [LAW:one-source-of-truth] The payload inputs the synthesized chrome reads —
// the settings menu's tray, controls and carousels, and edit chrome's
// customized banner — declared ONCE. The bundled default spreads this table
// into its variables; the synthesis passes ensure from it whatever their
// artifacts read that the config did not declare (brandon-settings-menu-d6f),
// so a config declaring nothing still gets a menu that renders, and a
// declaration here cannot drift from the one the default ships.
//
// [LAW:one-way-deps] It lives below both readers: default-dsl-config.ts
// imports the loader, and the loader runs the synthesis, so the synthesis
// cannot import the default without a cycle.

import type { VariableDecl } from "./dsl-types.js";
import type { DiagnosticsProjection } from "../render/diagnostics.js";
import { SESSION_ID_VAR_NAME } from "../var-system/sources.js";
import {
  ANSWERING,
  drawingVar,
  LANE_NAMES,
  laneFeedVar,
  UNFOLLOWED,
  type LaneFeed,
} from "./lanes.js";
import { CONFIG_KEY_TO_EFFECTIVE_VAR } from "./setting-projections.js";
import { EXPRESSION_SLOTS, type ExpressionSlot } from "../themes/policy.js";
import {
  GLOBAL_FIELDS,
  wireKindOf,
  type GlobalField,
} from "./globals-fields.js";

// The input declaration for one published `.effective` value: its row's
// primitive, defaulting to the row's floor ("" for a name, which has none of
// its own until the render settles it).
function effectiveInput(
  field: GlobalField,
  effectiveVar: string,
): VariableDecl {
  const row = GLOBAL_FIELDS[field];
  const kind = wireKindOf(field);
  const floor =
    row.kind === "session" || row.kind === "config" ? row.floor : "";
  return kind === "string"
    ? { kind: "input", path: effectiveVar, default: "" }
    : { kind: "input", path: effectiveVar, type: kind, default: floor };
}

const EFFECTIVE_INPUTS: Readonly<Record<string, VariableDecl>> =
  Object.fromEntries(
    [...CONFIG_KEY_TO_EFFECTIVE_VAR].map(([field, effectiveVar]) => [
      effectiveVar,
      effectiveInput(field as GlobalField, effectiveVar),
    ]),
  );

// [LAW:types-are-the-program] The input type of every LaneFeed field, so a
// field added to LaneFeed is a compile error here until it is declared.
const LANE_FEED_TYPES = {
  subscribers: "number",
  fps: "number",
  shown: "boolean",
} as const satisfies Record<keyof LaneFeed, "number" | "boolean">;
const LANE_FEED_FIELDS = Object.keys(LANE_FEED_TYPES) as ReadonlyArray<
  keyof LaneFeed
>;

// `term.cols`'s default below: the width a template reads when no render
// injected one.
export const TERM_COLS_FLOOR = 80;

export const PAYLOAD_INPUTS: Readonly<Record<string, VariableDecl>> = {
  project_dir: {
    kind: "input",
    path: "workspace.project_dir",
    default: "",
  },
  [SESSION_ID_VAR_NAME]: { kind: "input", path: "session_id", default: "" },
  // Transcript path (a top-level hookData field, spread onto the payload
  // root by payloadOf). Read by the quick-action tray's
  // openTranscript action — pass-through, no projection.
  transcript_path: {
    kind: "input",
    path: "transcript_path",
    default: "",
  },
  // The session's resume command and the config file it renders from
  // (RenderPayload.resumeCommand / .configPath), read by the quick-action
  // tray's `⎘ resume` and `↗ config`; "" is "none", which hides the glyph.
  resume_command: { kind: "input", path: "resumeCommand", default: "" },
  config_path: { kind: "input", path: "configPath", default: "" },
  // [LAW:one-source-of-truth] The value every setting and config-only global
  // renders with, whichever rung produced it — the theme, style and effect as
  // renderDsl settles them, every other one as the daemon resolved it. A
  // trigger's label and a picker's current-selection mark read it back, so
  // the label and the bar trace to one resolution. The daemon always provides
  // each; the default is the unreachable-absence floor.
  ...EFFECTIVE_INPUTS,
  // [LAW:one-source-of-truth] brandon-layout-edit-2gc.5 — does the config
  // file author the active preset's root, resolved alongside preset.effective
  // (RenderPayload.preset.customized). edit-chrome.ts's synthesized "↺ …
  // customized" segment gates on this directly; a hand-authored config can
  // read it too for its own reset affordance.
  "preset.customized": {
    kind: "input",
    path: "preset.customized",
    type: "boolean",
    default: false,
  },
  // Does the bundled default declare the active preset (RenderPayload
  // .preset.bundled) — false for a preset the user authored, which the
  // settings menu offers to delete.
  "preset.bundled": {
    kind: "input",
    path: "preset.bundled",
    type: "boolean",
    default: true,
  },
  // Each lane's feed of this session's frames (RenderPayload.feeds), one input
  // per field of LANE_FEED_TYPES.
  ...Object.fromEntries(
    LANE_NAMES.flatMap((lane) =>
      LANE_FEED_FIELDS.map((field) => [
        laneFeedVar(lane, field),
        {
          kind: "input",
          path: laneFeedVar(lane, field),
          type: LANE_FEED_TYPES[field],
          default: UNFOLLOWED[field],
        },
      ]),
    ),
  ),
  // Who this render is drawn for (Drawing): the daemon sets it beside the
  // payload, and a caller rendering without one draws as a request does.
  [drawingVar("by")]: {
    kind: "input",
    path: drawingVar("by"),
    default: ANSWERING.by,
  },
  [drawingVar("fps")]: {
    kind: "input",
    path: drawingVar("fps"),
    type: "number",
    default: 0,
  },
  // The settings door's indicator (src/render/diagnostics.ts,
  // DiagnosticsProjection): its label, "" while there is nothing to show, the
  // colours of the worst level the draw's diagnostics hold, and the key of
  // the message its click opens.
  ...Object.fromEntries(
    (
      ["label", "fg", "bg", "open"] as const satisfies ReadonlyArray<
        keyof DiagnosticsProjection
      >
    ).map((field) => [
      `diagnostics.${field}`,
      { kind: "input", path: `diagnostics.${field}`, default: "" },
    ]),
  ),

  // [LAW:one-source-of-truth] The usable terminal width for THIS render —
  // the exact post-reserve cell count FlexStrip wraps to. renderDsl injects
  // it into the payload from its own `opts.width`, the value a row fits to
  // (RenderBinding.width) and the strip wraps to, so a template reading it
  // and the wrap algebra can never disagree. Never cached: a resize is just a
  // new value on the same path, re-read every render. The default only
  // applies to compile-only callers that render without injecting a width.
  "term.cols": {
    kind: "input",
    path: "term.cols",
    type: "number",
    default: TERM_COLS_FLOOR,
  },

  // The tmux pane this session's Claude Code runs in, as its client reported
  // it; "" outside tmux (and for a client too old to say). It is the pane a
  // `slash` click types into, so IN_TMUX below is the gate for one.
  "tmux.pane": { kind: "input", path: "tmux.pane", default: "" },

  // Claude Code's auto-compact window as its `/autocompact` last wrote it
  // (src/segments/autocompact.ts, autoCompactControls): `window` in tokens,
  // 0 under `auto`, -1 (default) ⇒ not read; `applied` is that window capped
  // to the model's context window; `lower`/`higher` are the windows − and +
  // type, 0 where there is none. [LAW:no-silent-failure] `error` is the
  // settings file the daemon could not read, and the only field set when it
  // is.
  "autocompact.window": {
    kind: "input",
    path: "autocompact.window",
    type: "number",
    default: -1,
  },
  ...Object.fromEntries(
    ["applied", "lower", "higher"].map((field) => [
      `autocompact.${field}`,
      {
        kind: "input",
        path: `autocompact.${field}`,
        type: "number",
        default: 0,
      },
    ]),
  ),
  "autocompact.error": {
    kind: "input",
    path: "autocompact.error",
    default: "",
  },

  // Where the session is, as the daemon read it from the checkout on the
  // request, so these answer before the git lane does. `noRepo` is a read that found none.
  "location.main": { kind: "input", path: "location.main", default: "" },
  "location.worktree": {
    kind: "input",
    path: "location.worktree",
    default: "",
  },
  "location.subpath": { kind: "input", path: "location.subpath", default: "" },
  "location.noRepo": {
    kind: "input",
    path: "location.noRepo",
    type: "boolean",
    default: false,
  },
  "location.gitPending": {
    kind: "input",
    path: "location.gitPending",
    type: "boolean",
    default: false,
  },

  // The repo's browsable web page, transposed from its remote by the daemon.
  // "" is the genuine "no remote a browser can open" (local-only repo, bare
  // path remote) — the quick-action tray's link reads that value, not a flag.
  "git.repoUrl": { kind: "input", path: "git.repoUrl", default: "" },
};

// [LAW:one-source-of-truth] The payload fields the draw's own instant answers
// (brandon-unfiled-3248.8ro6, step 4): never stored in a view's payload,
// since they move with the instant, but read by each draw — an input at one
// is a projection (projections.ts), so a cache policy over it is refused at
// load, and the view's source answers it from the draw in progress
// (src/dsl/view-source.ts). Each key is a root field; why it moves is how a
// load error says it.
export const DRAW_PROJECTIONS = {
  today: "the day the draw is at",
  feeds: "the frames a lane was sent up to the draw's instant",
  drawing: "who the draw is for",
  diagnostics: "the errors and warnings the draw owes its reader",
} as const;
export type DrawProjection = keyof typeof DRAW_PROJECTIONS;

// The draw projection a payload path reads, if any.
export function drawProjectionAt(path: string): DrawProjection | undefined {
  const root = path.split(".", 1)[0]!;
  return Object.hasOwn(DRAW_PROJECTIONS, root)
    ? (root as DrawProjection)
    : undefined;
}

// [LAW:one-source-of-truth] Where each selection slot's `.effective` is read:
// the name the bar wears, which the slot's node answers (a rule's answer, or
// the decided name) — never the payload, so a rule reading the payload closes
// no cycle through it.
export const SLOT_PATHS: Readonly<Record<ExpressionSlot, string>> =
  Object.fromEntries(
    EXPRESSION_SLOTS.map((slot) => [
      slot,
      CONFIG_KEY_TO_EFFECTIVE_VAR.get(slot)!,
    ]),
  ) as Record<ExpressionSlot, string>;

// The selection slot whose `.effective` a payload path reads, if any.
export function slotAt(path: string): ExpressionSlot | undefined {
  return EXPRESSION_SLOTS.find((slot) => SLOT_PATHS[slot] === path);
}
