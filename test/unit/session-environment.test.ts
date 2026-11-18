// The environment a session's client reports, across the host's checkpoint:
// it becomes the session's environment and never reaches the renderer's
// context (src/daemon/foundations/session-env.ts).

import { PROTOCOL_VERSION } from "../../src/daemon/foundations/protocol";
import { checkRenderRequest } from "../../src/daemon/render-checkpoint";

function check(env: unknown, claudeConfigDir?: string) {
  return checkRenderRequest(
    {
      v: PROTOCOL_VERSION,
      kind: "render",
      hookData: {
        hook_event_name: "Status",
        session_id: "s1",
        transcript_path: "/p/transcript.jsonl",
        cwd: "/p",
        model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
        workspace: { current_dir: "/p", project_dir: "/p", added_dirs: [] },
      },
      args: ["cc-candybar"],
      cwd: "/p",
      ...(env !== undefined && { env }),
      ...(claudeConfigDir !== undefined && { claudeConfigDir }),
    } as never,
    { firstSightOfUnknownHookField: () => false },
    () => {},
    "/nowhere/home",
  );
}

describe("a reported environment", () => {
  test("is the session's, with its facts over it, and the renderer's context holds none of it", () => {
    const checked = check(
      { PATH: "/usr/bin", TOKEN: "secret", CLAUDE_CONFIG_DIR: "/old" },
      "/u/.claude-z",
    );
    if (!checked.ok) throw new Error(checked.problems.join("; "));
    expect(checked.environment).toEqual({
      kind: "ok",
      value: {
        PATH: "/usr/bin",
        TOKEN: "secret",
        CLAUDE_CODE_SESSION_ID: "s1",
        CLAUDE_PROJECT_DIR: "/p",
        CLAUDE_CONFIG_DIR: "/u/.claude-z",
      },
    });
    expect(checked.req).not.toHaveProperty("env");
    expect(JSON.stringify(checked.req)).not.toContain("secret");
  });

  test("from a client that sends none, is no environment, and says why", () => {
    const checked = check(undefined);
    if (!checked.ok) throw new Error(checked.problems.join("; "));
    expect(checked.environment).toEqual({
      kind: "failed",
      reason: expect.stringMatching(/client sent no environment/),
    });
  });

  test("that is not an object of strings is a problem with the request", () => {
    for (const env of [["PATH"], { PATH: 1 }, "PATH=/usr/bin", null]) {
      const checked = check(env);
      expect(checked).toMatchObject({
        ok: false,
        problems: expect.arrayContaining([
          "request 'env' is not an object of strings",
        ]),
      });
    }
  });
});
