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
  workspace: { current_dir: "/home/user/project", project_dir: "/home/user/project" },
};

describe("validateHookData — required fields", () => {
  test("valid minimal input produces an empty report", () => {
    const { report } = validateHookData(VALID_HOOK);
    expect(report.missingRequired).toHaveLength(0);
    expect(report.typeMismatches).toHaveLength(0);
    expect(report.unknownTopLevelFields).toHaveLength(0);
  });

  test("missing session_id appears in missingRequired", () => {
    const { session_id: _, ...rest } = VALID_HOOK;
    const { report } = validateHookData(rest);
    expect(report.missingRequired).toContain("session_id");
  });

  test("missing model.id appears in missingRequired", () => {
    const hook = { ...VALID_HOOK, model: { display_name: "Sonnet" } };
    const { report } = validateHookData(hook);
    expect(report.missingRequired).toContain("model.id");
  });

  test("missing workspace.project_dir appears in missingRequired", () => {
    const hook = { ...VALID_HOOK, workspace: { current_dir: "/tmp" } };
    const { report } = validateHookData(hook);
    expect(report.missingRequired).toContain("workspace.project_dir");
  });

  test("null value counts as missing", () => {
    const hook = { ...VALID_HOOK, session_id: null };
    const { report } = validateHookData(hook);
    expect(report.missingRequired).toContain("session_id");
  });
});

describe("validateHookData — type mismatches", () => {
  test("session_id as number produces a type mismatch", () => {
    const hook = { ...VALID_HOOK, session_id: 42 };
    const { report } = validateHookData(hook);
    expect(report.typeMismatches).toContainEqual(
      expect.objectContaining({ path: "session_id", expected: "string", got: "number" }),
    );
  });

  test("model as an array produces a mismatch (expected object)", () => {
    const hook = { ...VALID_HOOK, model: [] };
    const { report } = validateHookData(hook);
    expect(report.typeMismatches).toContainEqual(
      expect.objectContaining({ path: "model", expected: "object", got: "array" }),
    );
  });
});

describe("validateHookData — unknown fields", () => {
  test("a new top-level field Anthropic added appears in unknownTopLevelFields", () => {
    const hook = { ...VALID_HOOK, some_new_field: "surprise" };
    const { report } = validateHookData(hook);
    expect(report.unknownTopLevelFields).toContain("some_new_field");
  });

  test("known optional fields (effort, vim, agent, worktree) are not flagged", () => {
    const hook = {
      ...VALID_HOOK,
      effort: { level: "high" },
      vim: { mode: "NORMAL" },
      agent: { name: "reviewer" },
      worktree: { name: "feat", path: "/p", original_cwd: "/q" },
    };
    const { report } = validateHookData(hook);
    expect(report.unknownTopLevelFields).toHaveLength(0);
  });

  test("multiple unknown fields are all reported", () => {
    const hook = { ...VALID_HOOK, field_a: 1, field_b: 2 };
    const { report } = validateHookData(hook);
    expect(report.unknownTopLevelFields).toContain("field_a");
    expect(report.unknownTopLevelFields).toContain("field_b");
  });
});

describe("validateHookData — data pass-through", () => {
  test("data field carries the original value regardless of report contents", () => {
    const hook = { ...VALID_HOOK, session_id: "keeps-original" };
    const { data } = validateHookData(hook);
    expect(data.session_id).toBe("keeps-original");
  });

  test("non-object input returns an empty-like report without throwing", () => {
    expect(() => validateHookData(null)).not.toThrow();
    expect(() => validateHookData("bad")).not.toThrow();
    expect(() => validateHookData(42)).not.toThrow();
    const { report } = validateHookData(null);
    expect(report.missingRequired.length).toBeGreaterThan(0);
  });
});
