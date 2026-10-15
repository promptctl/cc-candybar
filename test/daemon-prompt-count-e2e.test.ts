// [LAW:nothing-unseen] brandon-effects-2gka.2rm, measured on a REAL daemon: the
// render event — its `render sid=…` log line — carries the session's prompt
// count and the count of user entries Claude Code wrote itself, so a count that
// stops moving can be told from a session with none, and a render whose hook
// carried no cost block (no metrics fold ran) reads `-`, not zero.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { logPath } from "../src/daemon/paths";
import { hookData, killAndWait, renderRequest } from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

const COST = {
  total_cost_usd: 0.1,
  total_duration_ms: 60_000,
  total_api_duration_ms: 20_000,
  total_lines_added: 0,
  total_lines_removed: 0,
};

describe("a daemon render's event counts the session's prompts", () => {
  let env: NodeJS.ProcessEnv;
  let sockPath: string;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let config: string;
  let daemon: RunningDaemon | undefined;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-prompts-e2e");
    ({ sockPath, env, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-prompts-e2e-"),
    );
    const at = (s: number) =>
      new Date(Date.now() - 60_000 + s * 1000).toISOString();
    writeFileSync(
      path.join(projectDir, "transcript.jsonl"),
      [
        {
          timestamp: at(0),
          type: "user",
          origin: { kind: "human" },
          message: { role: "user", content: "go" },
        },
        {
          timestamp: at(1),
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "a", name: "Bash", input: {} }],
          },
        },
        {
          timestamp: at(2),
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }],
          },
        },
        {
          timestamp: at(3),
          type: "user",
          isMeta: true,
          message: {
            role: "user",
            content: [{ type: "text", text: "Please continue" }],
          },
        },
        {
          timestamp: at(4),
          type: "user",
          origin: { kind: "task-notification" },
          message: {
            role: "user",
            content: "<task-notification>done</task-notification>",
          },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    // A bar that reads the count, so the daemon runs the metrics fold.
    config = path.join(projectDir, "messages.json5");
    writeFileSync(
      config,
      `{ segments: { msgs: { template: '{{ .metrics.messageCount }}' } }, root: { h: ['msgs'] } }`,
    );
    daemon = await spawnDaemonWithEnv(prepared.env);
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  const counts = (sessionId: string) =>
    readFileSync(logPath(env), "utf8")
      .split("\n")
      .filter((l) => l.includes(`render sid=${sessionId} `))
      .map((l) => ({
        prompts: l.match(/ prompts=(\S+) /)?.[1],
        ccEntries: l.match(/ ccEntries=(\S+) /)?.[1],
      }));

  test("one prompt, and two entries Claude Code wrote, on a render that folded the transcript", async () => {
    const sessionId = "prompts-e2e-folded";
    await renderRequest(sockPath, {
      hookData: { ...hookData(sessionId, projectDir), cost: COST },
      args: ["cc-candybar", "--config", config],
      cwd: projectDir,
    });
    expect(counts(sessionId).at(-1)).toEqual({ prompts: "1", ccEntries: "2" });
  });

  test("a render with no cost block reads `-` for both", async () => {
    const sessionId = "prompts-e2e-no-cost";
    await renderRequest(sockPath, {
      hookData: hookData(sessionId, projectDir),
      args: ["cc-candybar", "--config", config],
      cwd: projectDir,
    });
    expect(counts(sessionId).at(-1)).toEqual({ prompts: "-", ccEntries: "-" });
  });
});
