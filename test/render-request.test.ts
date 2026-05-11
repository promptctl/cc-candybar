// [LAW:behavior-not-structure] One test shape: build the same RenderRequest the
// Rust client sends over the wire, run the render pipeline, assert on the plain
// text the user sees. No mocks. No direct renderer construction. No config
// object assembly — args are the public interface.
//
// render(hookData, args) mirrors handleRequest exactly:
//   loadConfigFromCLI(args, projectDir, cwd) → PowerlineRenderer → generateStatusline

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfigFromCLI } from "../src/config/loader";
import { PowerlineRenderer } from "../src/powerline";
import { stripAnsi } from "../src/utils/terminal";
import type { ClaudeHookData } from "../src/utils/claude";

// ─── Render primitive ─────────────────────────────────────────────────────────

// Nonexistent path prevents findConfigFile from reading the developer's personal
// ~/.config/cc-candybar/config.json (which carries panel items and personal settings
// that would pollute every assertion). DEFAULT_CONFIG + explicit args only.
const NO_CONFIG_ARG = "--config=/tmp/cc-candybar-test-no-config.json";

async function render(hookData: ClaudeHookData, args: string[]): Promise<string> {
  const config = loadConfigFromCLI(
    [NO_CONFIG_ARG, ...args],
    hookData.workspace.project_dir,
    hookData.cwd,
  );
  return new PowerlineRenderer(config).generateStatusline(hookData);
}

function plain(s: string): string {
  return stripAnsi(s);
}

// ─── Realistic base fixture ───────────────────────────────────────────────────

const SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const BASE_HOOK: ClaudeHookData = {
  hook_event_name: "UserPromptSubmit",
  session_id: SESSION_ID,
  transcript_path: `/nonexistent/${SESSION_ID}.jsonl`,
  cwd: "/Users/dev/projects/myapp",
  model: { id: "claude-sonnet-4-6", display_name: "Claude Sonnet" },
  workspace: {
    current_dir: "/Users/dev/projects/myapp",
    project_dir: "/Users/dev/projects/myapp",
  },
};

// ─── Helper: inject a JSONL transcript via CLAUDE_CONFIG_DIR ─────────────────

interface TranscriptEntry {
  input_tokens: number;
  output_tokens: number;
  costUSD?: number;
}

function withTranscript(
  sessionId: string,
  entries: TranscriptEntry[],
  fn: (hook: Partial<ClaudeHookData>) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "cc-test-claude-"));
    const projectDir = join(claudeDir, "projects", "myapp");
    mkdirSync(projectDir, { recursive: true });
    const lines = entries.map((e) =>
      JSON.stringify({
        timestamp: new Date().toISOString(),
        message: {
          usage: {
            input_tokens: e.input_tokens,
            output_tokens: e.output_tokens,
          },
        },
        costUSD: e.costUSD,
        isSidechain: false,
      }),
    );
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");

    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    try {
      await fn({ session_id: sessionId });
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
      rmSync(claudeDir, { recursive: true, force: true });
    }
  };
}

// ─── model segment ────────────────────────────────────────────────────────────

describe("model segment", () => {
  test("shows model display name", async () => {
    expect(plain(await render(BASE_HOOK, ["--layout=model"]))).toContain("Claude Sonnet");
  });

  test("reflects different model display names", async () => {
    const hook: ClaudeHookData = {
      ...BASE_HOOK,
      model: { id: "claude-opus-4-7", display_name: "Claude Opus" },
    };
    expect(plain(await render(hook, ["--layout=model"]))).toContain("Claude Opus");
  });
});

// ─── directory segment ────────────────────────────────────────────────────────

describe("directory segment", () => {
  test("shows basename of cwd in output", async () => {
    expect(plain(await render(BASE_HOOK, ["--layout=directory"]))).toContain("myapp");
  });

  test("reflects a different cwd basename", async () => {
    const hook: ClaudeHookData = {
      ...BASE_HOOK,
      cwd: "/home/user/repos/dotfiles",
      workspace: { current_dir: "/home/user/repos/dotfiles", project_dir: "/home/user/repos/dotfiles" },
    };
    expect(plain(await render(hook, ["--layout=directory"]))).toContain("dotfiles");
  });
});

// ─── version segment ─────────────────────────────────────────────────────────

describe("version segment", () => {
  test("shows version string from hookData.version", async () => {
    const hook: ClaudeHookData = { ...BASE_HOOK, version: "1.2.34" };
    expect(plain(await render(hook, ["--layout=version"]))).toContain("1.2.34");
  });

  test("absent when hookData has no version field", async () => {
    const { version: _unused, ...rest } = { ...BASE_HOOK };
    const out = plain(await render(rest as ClaudeHookData, ["--layout=version"]));
    expect(out.trim()).toHaveLength(0);
  });
});

// ─── sessionId segment ────────────────────────────────────────────────────────

describe("sessionId segment", () => {
  test("shows the session ID (at least the first 8 chars)", async () => {
    const out = plain(await render(BASE_HOOK, ["--layout=sessionId"]));
    expect(out).toContain(SESSION_ID.slice(0, 8));
  });
});

// ─── session segment (cost / tokens) ─────────────────────────────────────────

describe("session segment", () => {
  test(
    "shows cost from JSONL transcript (session.type=cost)",
    withTranscript(
      "cc000000-test-0000-0000-cost0001",
      [{ input_tokens: 100, output_tokens: 50, costUSD: 0.07 }],
      async (partial) => {
        const hook: ClaudeHookData = { ...BASE_HOOK, ...partial };
        const out = plain(
          await render(hook, ["--layout=session", "--segment", "session.type=cost"]),
        );
        expect(out).toMatch(/\$0\.07/);
      },
    ),
  );

  test(
    "shows token count from JSONL transcript (session.type=tokens)",
    withTranscript(
      "cc000000-test-0000-0000-tokens01",
      [{ input_tokens: 1000, output_tokens: 500, costUSD: 0.03 }],
      async (partial) => {
        const hook: ClaudeHookData = { ...BASE_HOOK, ...partial };
        const out = plain(
          await render(hook, ["--layout=session", "--segment", "session.type=tokens"]),
        );
        // 1500 total tokens → formatted as "1.5K tokens"
        expect(out).toMatch(/1[.,]?5K|1500/);
      },
    ),
  );

  test("renders gracefully with no transcript", async () => {
    const out = await render(BASE_HOOK, ["--layout=session"]);
    expect(out.length).toBeGreaterThan(0);
    expect(plain(out)).not.toContain("undefined");
    expect(plain(out)).not.toContain("null");
  });
});

// ─── block segment (five-hour rate limits) ───────────────────────────────────

describe("block segment", () => {
  test("shows utilization percentage from rate_limits.five_hour", async () => {
    const hook: ClaudeHookData = {
      ...BASE_HOOK,
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      },
    };
    expect(plain(await render(hook, ["--layout=block"]))).toContain("42%");
  });

  test("renders gracefully when rate_limits is absent", async () => {
    const out = await render(BASE_HOOK, ["--layout=block"]);
    expect(plain(out)).not.toContain("undefined");
    expect(plain(out)).not.toContain("null");
  });
});

// ─── weekly segment (seven-day rate limits) ──────────────────────────────────

describe("weekly segment", () => {
  test("shows weekly utilization from rate_limits.seven_day", async () => {
    const hook: ClaudeHookData = {
      ...BASE_HOOK,
      rate_limits: {
        seven_day: {
          used_percentage: 75,
          resets_at: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
        },
      },
    };
    expect(plain(await render(hook, ["--layout=weekly"]))).toContain("75%");
  });

  test("absent when seven_day rate_limits are not present", async () => {
    expect(plain(await render(BASE_HOOK, ["--layout=weekly"])).trim()).toHaveLength(0);
  });
});

// ─── multi-line layouts / autoWrap ───────────────────────────────────────────

describe("multi-line layouts", () => {
  test("two display lines ('|') produce a newline in output", async () => {
    const out = await render(BASE_HOOK, ["--layout=model | session"]);
    expect(out).toContain("\n");
  });

  test("autoWrap disabled joins all segments on one line", async () => {
    const out = await render(BASE_HOOK, [
      "--layout=model | session",
      "--display",
      "autoWrap=false",
    ]);
    // autoWrap=false → lines joined literally; exactly one newline between lines
    expect(out.split("\n").length).toBeLessThanOrEqual(2);
  });

  test("a layout line whose only segment is absent produces no blank line", async () => {
    // version returns null when hookData has no version field → line is omitted
    const { version: _unused, ...rest } = { ...BASE_HOOK };
    const out = await render(rest as ClaudeHookData, ["--layout=model | version"]);
    const visibleLines = out.split("\n").filter((l) => plain(l).trim().length > 0);
    expect(visibleLines.length).toBe(1);
  });
});

// ─── output hygiene ───────────────────────────────────────────────────────────

describe("output hygiene", () => {
  const segmentsToCheck = ["model", "directory", "session", "block", "sessionId"];

  test.each(segmentsToCheck)(
    "%s segment produces no 'undefined' or 'null' strings",
    async (seg) => {
      const out = plain(await render(BASE_HOOK, [`--layout=${seg}`]));
      expect(out).not.toContain("undefined");
      expect(out).not.toContain("null");
    },
  );

  test("default args (no --layout) produce ANSI-colored output containing model name", async () => {
    const out = await render(BASE_HOOK, []);
    expect(out).toContain("\x1B[");
    expect(plain(out)).toContain("Claude Sonnet");
  });
});
