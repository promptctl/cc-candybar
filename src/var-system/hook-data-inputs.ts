// [LAW:one-source-of-truth] One authoritative list of every ClaudeHookData
// leaf field that is automatically available in segment templates without
// an explicit user declaration.  The list mirrors the ClaudeHookData type
// in utils/claude.ts — when that type gains or loses fields, update here.
//
// Field naming: the variable name in the store is the dotted path the user
// writes in templates (e.g. `{{.model.id}}`), matching the payload path.
// That makes the mapping maximally obvious: name === path for every entry.
//
// workspace.added_dirs is included as type "array" (string[] in the payload).
// Nullable leaf parents (context_window.current_usage, rate_limits.*) are
// included; resolvePath returns undefined for a null parent, which triggers
// applyFallback → typed zero.

import type { SourceRegistry } from "./sources.js";
import type { VarType } from "./types.js";

export interface HookDataField {
  /** Variable name in the store AND the dotted path for template access. */
  readonly name: string;
  /** Dotted path passed to resolvePath against the raw hook data payload. */
  readonly path: string;
  readonly type: VarType;
}

// [LAW:one-source-of-truth] Single definition, used by both the runtime
// (declareHookDataInputs) and the static validator (dsl-loader cross-ref
// pass) so the two never diverge.
export const HOOK_DATA_FIELDS: readonly HookDataField[] = [
  // ── Always-present fields ────────────────────────────────────────────────
  { name: "hook_event_name",      path: "hook_event_name",      type: "string" },
  { name: "session_id",           path: "session_id",           type: "string" },
  { name: "transcript_path",      path: "transcript_path",      type: "string" },
  { name: "cwd",                  path: "cwd",                  type: "string" },
  { name: "model.id",             path: "model.id",             type: "string" },
  { name: "model.display_name",   path: "model.display_name",   type: "string" },
  { name: "workspace.current_dir",  path: "workspace.current_dir",  type: "string" },
  { name: "workspace.project_dir",  path: "workspace.project_dir",  type: "string" },
  { name: "workspace.added_dirs",   path: "workspace.added_dirs",   type: "array"  },

  // ── Optional scalar fields ────────────────────────────────────────────────
  // Absent → resolvePath returns undefined → applyFallback → typed zero / ""
  { name: "workspace.git_worktree",  path: "workspace.git_worktree",  type: "string" },
  { name: "session_name",            path: "session_name",            type: "string" },
  { name: "version",                 path: "version",                 type: "string" },
  { name: "output_style.name",       path: "output_style.name",       type: "string" },
  { name: "effort.level",            path: "effort.level",            type: "string" },
  { name: "vim.mode",                path: "vim.mode",                type: "string" },
  { name: "agent.name",              path: "agent.name",              type: "string" },
  { name: "worktree.name",           path: "worktree.name",           type: "string" },
  { name: "worktree.path",           path: "worktree.path",           type: "string" },
  { name: "worktree.branch",         path: "worktree.branch",         type: "string" },
  { name: "worktree.original_cwd",   path: "worktree.original_cwd",   type: "string" },
  { name: "worktree.original_branch",path: "worktree.original_branch",type: "string" },

  { name: "exceeds_200k_tokens", path: "exceeds_200k_tokens", type: "boolean" },
  { name: "thinking.enabled",    path: "thinking.enabled",    type: "boolean" },

  { name: "cost.total_cost_usd",        path: "cost.total_cost_usd",        type: "number" },
  { name: "cost.total_duration_ms",     path: "cost.total_duration_ms",     type: "number" },
  { name: "cost.total_api_duration_ms", path: "cost.total_api_duration_ms", type: "number" },
  { name: "cost.total_lines_added",     path: "cost.total_lines_added",     type: "number" },
  { name: "cost.total_lines_removed",   path: "cost.total_lines_removed",   type: "number" },

  { name: "context_window.total_input_tokens",  path: "context_window.total_input_tokens",  type: "number" },
  { name: "context_window.total_output_tokens", path: "context_window.total_output_tokens", type: "number" },
  { name: "context_window.context_window_size", path: "context_window.context_window_size", type: "number" },
  // used_percentage / remaining_percentage are number|null in the schema —
  // resolvePath returns null (treated as undefined by applyFallback → 0).
  { name: "context_window.used_percentage",      path: "context_window.used_percentage",      type: "number" },
  { name: "context_window.remaining_percentage", path: "context_window.remaining_percentage", type: "number" },
  // current_usage parent is null before first API call — resolvePath
  // returns undefined for children, giving typed-zero fallback.
  { name: "context_window.current_usage.input_tokens",              path: "context_window.current_usage.input_tokens",              type: "number" },
  { name: "context_window.current_usage.output_tokens",             path: "context_window.current_usage.output_tokens",             type: "number" },
  { name: "context_window.current_usage.cache_creation_input_tokens",path: "context_window.current_usage.cache_creation_input_tokens",type: "number" },
  { name: "context_window.current_usage.cache_read_input_tokens",   path: "context_window.current_usage.cache_read_input_tokens",   type: "number" },

  { name: "rate_limits.five_hour.used_percentage", path: "rate_limits.five_hour.used_percentage", type: "number" },
  { name: "rate_limits.five_hour.resets_at",       path: "rate_limits.five_hour.resets_at",       type: "number" },
  { name: "rate_limits.seven_day.used_percentage", path: "rate_limits.seven_day.used_percentage",  type: "number" },
  { name: "rate_limits.seven_day.resets_at",       path: "rate_limits.seven_day.resets_at",        type: "number" },
];

// Pre-built name set used by the static validator and scope helpers.
// [LAW:one-source-of-truth] Derived once from HOOK_DATA_FIELDS; no duplicate definition.
export const HOOK_DATA_NAMES: ReadonlySet<string> = new Set(
  HOOK_DATA_FIELDS.map((f) => f.name),
);

// Declare every hook data field as an input box in the registry.
// Call this once during renderer/registry setup, AFTER user-declared variables,
// so user declarations shadow auto-declared ones without collision.
//
// [LAW:single-enforcer] All hook data input declarations go through here —
// no caller should call registry.declareInput for hook data paths directly.
export function declareHookDataInputs(registry: SourceRegistry): void {
  for (const field of HOOK_DATA_FIELDS) {
    if (!registry.has(field.name)) {
      registry.declareInput(field.name, field.path, field.type);
    }
  }
}
