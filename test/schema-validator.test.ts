// [LAW:behavior-not-structure] Tests assert on the ValidationReport values —
// never on internal sets or arrays. A missing field produces a report entry;
// an unknown field produces a report entry. That's the observable contract.

import { validateHookData } from "../src/utils/schema-validator";

const VALID_HOOK = {
  hook_event_name: "UserPromptSubmit",
  session_id: "abc123",
  transcript_path: "/tmp/abc123.jsonl",
  cwd: "/home/user/project",
  model: { id: "claude-sonnet-4-6", display_name: "Claude Sonnet" },
  workspace: { current_dir: "/home/user/project", project_dir: "/home/user/project", added_dirs: [] },
};

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("validateHookData — happy path", () => {
  test("valid minimal hook produces a clean report", () => {
    const { report } = validateHookData(VALID_HOOK);
    expect(report.missingRequired).toHaveLength(0);
    expect(report.typeMismatches).toHaveLength(0);
    expect(report.unknownTopLevelFields).toHaveLength(0);
  });

  test("valid hook with all known optional fields produces a clean report", () => {
    const hook = {
      ...VALID_HOOK,
      session_name: "my-session",
      version: "1.2.3",
      output_style: { name: "default" },
      cost: {
        total_cost_usd: 0.12,
        total_duration_ms: 5000,
        total_api_duration_ms: 2000,
        total_lines_added: 50,
        total_lines_removed: 10,
      },
      context_window: {
        total_input_tokens: 8500,
        total_output_tokens: 1200,
        context_window_size: 200000,
        used_percentage: null,       // nullable per schema
        remaining_percentage: null,  // nullable per schema
        current_usage: null,         // nullable per schema
      },
      exceeds_200k_tokens: false,
      effort: { level: "high" },
      thinking: { enabled: true },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
      },
      vim: { mode: "NORMAL" },
      agent: { name: "security-reviewer" },
      worktree: { name: "my-feature", path: "/worktrees/feat", original_cwd: "/project" },
    };
    const { report } = validateHookData(hook);
    expect(report.missingRequired).toHaveLength(0);
    expect(report.typeMismatches).toHaveLength(0);
    expect(report.unknownTopLevelFields).toHaveLength(0);
  });
});

// ─── Required fields — all 9 must be enforced ─────────────────────────────────

describe("validateHookData — required fields", () => {
  test("empty object reports all 9 required fields as missing", () => {
    const { report } = validateHookData({});
    const required = [
      "session_id",
      "transcript_path",
      "cwd",
      "model",
      "model.id",
      "model.display_name",
      "workspace",
      "workspace.current_dir",
      "workspace.project_dir",
    ];
    for (const field of required) {
      expect(report.missingRequired).toContain(field);
    }
  });

  test("missing session_id", () => {
    const { session_id: _, ...rest } = VALID_HOOK;
    expect(validateHookData(rest).report.missingRequired).toContain("session_id");
  });

  test("missing transcript_path", () => {
    const { transcript_path: _, ...rest } = VALID_HOOK;
    expect(validateHookData(rest).report.missingRequired).toContain("transcript_path");
  });

  test("missing cwd", () => {
    const { cwd: _, ...rest } = VALID_HOOK;
    expect(validateHookData(rest).report.missingRequired).toContain("cwd");
  });

  test("missing model object", () => {
    const { model: _, ...rest } = VALID_HOOK;
    expect(validateHookData(rest).report.missingRequired).toContain("model");
  });

  test("missing model.id", () => {
    const hook = { ...VALID_HOOK, model: { display_name: "Sonnet" } };
    expect(validateHookData(hook).report.missingRequired).toContain("model.id");
  });

  test("missing model.display_name", () => {
    const hook = { ...VALID_HOOK, model: { id: "claude-sonnet-4-6" } };
    expect(validateHookData(hook).report.missingRequired).toContain("model.display_name");
  });

  test("missing workspace object", () => {
    const { workspace: _, ...rest } = VALID_HOOK;
    expect(validateHookData(rest).report.missingRequired).toContain("workspace");
  });

  test("missing workspace.current_dir", () => {
    const hook = { ...VALID_HOOK, workspace: { project_dir: "/p", added_dirs: [] } };
    expect(validateHookData(hook).report.missingRequired).toContain("workspace.current_dir");
  });

  test("missing workspace.project_dir", () => {
    const hook = { ...VALID_HOOK, workspace: { current_dir: "/p", added_dirs: [] } };
    expect(validateHookData(hook).report.missingRequired).toContain("workspace.project_dir");
  });

  test("null value counts as missing (same as absent)", () => {
    const hook = { ...VALID_HOOK, session_id: null };
    expect(validateHookData(hook).report.missingRequired).toContain("session_id");
  });
});

// ─── Type mismatches ──────────────────────────────────────────────────────────

describe("validateHookData — type mismatches", () => {
  test("session_id as number", () => {
    const hook = { ...VALID_HOOK, session_id: 42 };
    expect(validateHookData(hook).report.typeMismatches).toContainEqual(
      expect.objectContaining({ path: "session_id", expected: "string", got: "number" }),
    );
  });

  test("cwd as boolean", () => {
    const hook = { ...VALID_HOOK, cwd: true };
    expect(validateHookData(hook).report.typeMismatches).toContainEqual(
      expect.objectContaining({ path: "cwd", expected: "string", got: "boolean" }),
    );
  });

  test("model as array (expected non-array object)", () => {
    const hook = { ...VALID_HOOK, model: [] };
    expect(validateHookData(hook).report.typeMismatches).toContainEqual(
      expect.objectContaining({ path: "model", expected: "object", got: "array" }),
    );
  });

  test("model.id as number", () => {
    const hook = { ...VALID_HOOK, model: { id: 99, display_name: "X" } };
    expect(validateHookData(hook).report.typeMismatches).toContainEqual(
      expect.objectContaining({ path: "model.id", expected: "string", got: "number" }),
    );
  });

  test("workspace.current_dir as number", () => {
    const hook = { ...VALID_HOOK, workspace: { ...VALID_HOOK.workspace, current_dir: 0 } };
    expect(validateHookData(hook).report.typeMismatches).toContainEqual(
      expect.objectContaining({ path: "workspace.current_dir", expected: "string", got: "number" }),
    );
  });

  test("a type mismatch does not also appear in missingRequired", () => {
    const hook = { ...VALID_HOOK, session_id: 42 };
    const { report } = validateHookData(hook);
    expect(report.missingRequired).not.toContain("session_id");
    expect(report.typeMismatches).toContainEqual(
      expect.objectContaining({ path: "session_id" }),
    );
  });
});

// ─── Unknown top-level fields ─────────────────────────────────────────────────

describe("validateHookData — unknown fields", () => {
  test("a single unknown field is reported", () => {
    const hook = { ...VALID_HOOK, some_new_field: "surprise" };
    expect(validateHookData(hook).report.unknownTopLevelFields).toContain("some_new_field");
  });

  test("multiple unknown fields are all reported", () => {
    const hook = { ...VALID_HOOK, field_a: 1, field_b: 2 };
    const { report } = validateHookData(hook);
    expect(report.unknownTopLevelFields).toContain("field_a");
    expect(report.unknownTopLevelFields).toContain("field_b");
  });

  test("all schema-defined optional fields are not flagged", () => {
    // Exhaustive list — if Anthropic adds something and we forget to add it to
    // KNOWN_TOP_LEVEL, this test fails and reminds us to add a handler.
    const hook = {
      ...VALID_HOOK,
      session_name: "x",
      version: "1.0.0",
      output_style: { name: "default" },
      cost: { total_cost_usd: 0, total_duration_ms: 0, total_api_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
      context_window: { total_input_tokens: 0, total_output_tokens: 0, context_window_size: 200000, used_percentage: null, remaining_percentage: null, current_usage: null },
      exceeds_200k_tokens: false,
      effort: { level: "high" },
      thinking: { enabled: false },
      rate_limits: { five_hour: { used_percentage: 10, resets_at: 9999 } },
      vim: { mode: "INSERT" },
      agent: { name: "agent" },
      worktree: { name: "w", path: "/p", original_cwd: "/q" },
    };
    expect(validateHookData(hook).report.unknownTopLevelFields).toHaveLength(0);
  });
});

// ─── Data pass-through and edge cases ────────────────────────────────────────

describe("validateHookData — data pass-through and edge cases", () => {
  test("data carries the original value regardless of report state", () => {
    const hook = { ...VALID_HOOK, session_id: "keep-me" };
    expect(validateHookData(hook).data.session_id).toBe("keep-me");
  });

  test("null input does not throw and reports all required fields missing", () => {
    expect(() => validateHookData(null)).not.toThrow();
    const { report } = validateHookData(null);
    expect(report.missingRequired.length).toBeGreaterThan(0);
  });

  test("string input does not throw and reports required fields missing", () => {
    expect(() => validateHookData("bad")).not.toThrow();
    expect(validateHookData("bad").report.missingRequired.length).toBeGreaterThan(0);
  });

  test("array input does not throw and reports required fields missing", () => {
    expect(() => validateHookData([])).not.toThrow();
    expect(validateHookData([]).report.missingRequired.length).toBeGreaterThan(0);
  });
});
