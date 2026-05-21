// [LAW:single-enforcer] The one function that maps (charset, displayStyle) to a
// concrete PowerlineSymbols set. The renderer and any verification harness build
// symbols through here so a symbol value has exactly one source — there is no
// second mapping that could silently disagree about which glyph a segment uses.
//
// [LAW:dataflow-not-control-flow] displayStyle and charset are values that
// select glyphs; the same fields are populated every call. "minimal"/"capsule"
// only change the cap glyphs (right/left) — they are not branches that skip
// fields.

import type { PowerlineSymbols } from "./renderer.js";
import { SYMBOLS, TEXT_SYMBOLS } from "../utils/constants.js";

export function buildPowerlineSymbols(
  charset: "unicode" | "text",
  displayStyle: "minimal" | "powerline" | "capsule",
): PowerlineSymbols {
  const isMinimalStyle = displayStyle === "minimal";
  const isCapsuleStyle = displayStyle === "capsule";
  const symbolSet = charset === "text" ? TEXT_SYMBOLS : SYMBOLS;

  return {
    right: isMinimalStyle
      ? ""
      : isCapsuleStyle
        ? symbolSet.right_rounded
        : symbolSet.right,
    left: isCapsuleStyle ? symbolSet.left_rounded : "",
    branch: symbolSet.branch,
    model: symbolSet.model,
    git_clean: symbolSet.git_clean,
    git_dirty: symbolSet.git_dirty,
    git_conflicts: symbolSet.git_conflicts,
    git_ahead: symbolSet.git_ahead,
    git_behind: symbolSet.git_behind,
    git_worktree: symbolSet.git_worktree,
    git_tag: symbolSet.git_tag,
    git_sha: symbolSet.git_sha,
    git_upstream: symbolSet.git_upstream,
    git_stash: symbolSet.git_stash,
    git_time: symbolSet.git_time,
    session_cost: symbolSet.session_cost,
    block_cost: symbolSet.block_cost,
    today_cost: symbolSet.today_cost,
    context_time: symbolSet.context_time,
    metrics_response: symbolSet.metrics_response,
    metrics_last_response: symbolSet.metrics_last_response,
    metrics_duration: symbolSet.metrics_duration,
    metrics_messages: symbolSet.metrics_messages,
    metrics_lines_added: symbolSet.metrics_lines_added,
    metrics_lines_removed: symbolSet.metrics_lines_removed,
    metrics_burn: symbolSet.metrics_burn,
    version: symbolSet.version,
    bar_filled: symbolSet.bar_filled,
    bar_empty: symbolSet.bar_empty,
    env: symbolSet.env,
    session_id: symbolSet.session_id,
    weekly_cost: symbolSet.weekly_cost,
  };
}
