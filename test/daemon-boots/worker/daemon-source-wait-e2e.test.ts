// [LAW:verifiable-goals] A request waits for what its frame would draw as
// pending. A source whose command interpolates another's has no run until that
// one answers, so the wait covers the run it names after the first lands: the
// first answered render of the session draws both, with nothing pending.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf } from "../../../src/render/frame";
import { frameRequest, hookData } from "../../helpers/daemon-e2e";
import {
  answeredRender,
  loggedLines,
  renderEventsOf,
} from "../../helpers/daemon-log";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

describe("a request's wait over sources that read each other", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let daemon: InWorkerDaemon;

  beforeAll(() => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-source-wait-e2e");
    env = prepared.env;
    removeTmpDirs = prepared.removeTmpDirs;
    projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-source-wait-e2e-project-"),
    );
    daemon = startDaemon(prepared.env);
  });

  afterAll(async () => {
    await daemon?.stop();
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("a shell source that interpolates another draws its first answered render with nothing pending", async () => {
    const config = path.join(projectDir, "chain.json5");
    writeFileSync(
      config,
      `{
        variables: {
          first: { kind: "shell", command: "echo one", cache: { never: true } },
          second: {
            kind: "shell",
            command: "echo two",
            cache: { key: "{{ .first }}" },
          },
        },
        segments: { chain: { template: "chain={{ .first }}-{{ .second }}" } },
        root: { h: ["chain"] },
      }`,
    );
    const sid = "source-wait-chain";
    const frame = await frameRequest(daemon, {
      cwd: projectDir,
      hookData: hookData(sid, projectDir),
      args: ["cc-candybar", "--config-only", config],
    });
    expect(textOf(frame)).toContain("chain=one-two");
    // A render whose wait ended at the deadline may draw pending (a starting
    // renderer can spend the whole budget before the wait begins) and is asked
    // again. One whose wait ended otherwise waited for every run its view
    // names, the second's included, so it drew nothing pending.
    const events = await loggedLines(
      env,
      (lines) => renderEventsOf(lines, sid).filter(answeredRender),
      (answered) => answered.some((e) => !/ ended=deadline(?: |$)/.test(e)),
      `an answered render of ${sid} whose wait did not end at the deadline`,
    );
    const waited = events.filter((e) => !/ ended=deadline(?: |$)/.test(e));
    expect(waited.filter((e) => !/ pending=-(?: |$)/.test(e))).toEqual([]);
  });
});
