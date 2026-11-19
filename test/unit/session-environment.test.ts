// The environment a session's client reports, across the host's checkpoint:
// it becomes the session's environment and never reaches the renderer's
// context (src/daemon/foundations/session-env.ts).

import { PROTOCOL_VERSION } from "../../src/daemon/foundations/protocol";
import { checkRenderRequest } from "../../src/daemon/render-checkpoint";
import vector from "../fixtures/session-environment-key.json";
import { environmentKey } from "../../src/daemon/foundations/session-env";

function check(
  env: unknown,
  claudeConfigDir?: string,
  extra: Record<string, unknown> = {},
  accountHome: () => string = () => "/account/home",
) {
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
      ...extra,
    } as never,
    { firstSightOfUnknownHookField: () => false },
    () => {},
    "/nowhere/home",
    { reportedFor: () => null, accountHome },
  );
}

describe("a reported environment", () => {
  test("home expansion uses the reported cwd or the account home, acquired only for a tilde", () => {
    const account = jest.fn(() => "/account/home");
    for (const [env, config, path] of [
      [{}, "chosen", "/p/chosen"],
      [{ HOME: "relative-home" }, "~/chosen", "/p/relative-home/chosen"],
      [{}, "~/chosen", "/account/home/chosen"],
    ] as const) {
      const checked = check(
        env,
        undefined,
        { envKey: environmentKey(env), args: ["bar", "--config-only", config] },
        account,
      );
      if (!checked.ok) throw new Error(checked.problems.join("; "));
      expect(checked.req.requested.target.path).toBe(path);
    }
    expect(account).toHaveBeenCalledTimes(1);
  });
  test("agrees with the native wire digest for numeric, escaped and non-ASCII names and values", () => {
    expect(environmentKey(Object.fromEntries(vector.pairs))).toBe(
      vector.sha256,
    );
    expect(
      environmentKey(Object.fromEntries([...vector.pairs].reverse())),
    ).toBe(vector.sha256);
  });

  test("a verified snapshot supplies hints from the client's cwd and home and stays outside the renderer", () => {
    const env = {
      HOME: "/client/home",
      SSH_TTY: "/dev/pts/3",
      CC_CANDYBAR_CONFIG: "~/bar.json5",
      CLAUDE_CONFIG_DIR: "claude",
      TOKEN: "private-test-value",
    };
    const envKey = environmentKey(env);
    const checked = check(env, "/forged", {
      envKey,
      ssh: false,
      configEnv: "/forged",
      termCols: 117,
      extraField: env,
    });
    if (!checked.ok) throw new Error(checked.problems.join("; "));
    expect(checked.req.hints).toMatchObject({
      ssh: true,
      tmux: null,
      configEnv: "/client/home/bar.json5",
      claudeConfigDir: "/p/claude",
      termCols: 117,
    });
    expect(checked.req.requested.target.path).toBe("/client/home/bar.json5");
    expect(JSON.stringify(checked.req)).not.toContain("private-test-value");
    expect(checked.req).not.toHaveProperty("envKey");
    const overridden = check(env, undefined, {
      envKey,
      args: ["cc-candybar", "--config-only", "~/chosen.json5"],
    });
    if (!overridden.ok) throw new Error(overridden.problems.join("; "));
    expect(overridden.req.requested.target.path).toBe(
      "/client/home/chosen.json5",
    );
  });

  test("a malformed, missing or mismatched full report cannot register an environment", () => {
    for (const [env, envKey] of [
      [{}, "X".repeat(64)],
      [undefined, environmentKey({})],
      [{ VALUE: "private-test-value" }, environmentKey({})],
    ]) {
      const checked = check(env, undefined, { envKey });
      expect(checked).toMatchObject({
        ok: false,
        problems: [expect.stringContaining("envKey")],
      });
      expect(JSON.stringify(checked)).not.toContain("private-test-value");
    }
  });
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
