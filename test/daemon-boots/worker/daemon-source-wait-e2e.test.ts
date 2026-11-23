// [LAW:verifiable-goals] A request waits for what its frame would draw as
// pending. A source whose key is another's value names no run until that one
// answers, so the wait covers the run it names after the first lands: the
// first answered render of the session draws both, with nothing pending.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { textOf } from "../../../src/render/frame";
import { frameRequest, hookData } from "../../helpers/daemon-e2e";
import { keptRenders, loggedLines } from "../../helpers/daemon-log";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { jestTmpDir } from "../../helpers/jest-tmp";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

describe("a request's wait over sources that read each other", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let scratch: string;
  let daemon: InWorkerDaemon;

  beforeAll(() => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-source-wait-e2e");
    env = prepared.env;
    removeTmpDirs = prepared.removeTmpDirs;
    scratch = jestTmpDir("fixtures");
    mkdirSync(scratch, { recursive: true });
    daemon = startDaemon(prepared.env);
  });

  afterAll(async () => {
    await daemon?.stop();
    rmSync(scratch, { recursive: true, force: true });
    removeTmpDirs();
  });

  const request = (sid: string, dir: string, config: string) =>
    frameRequest(daemon, {
      cwd: dir,
      hookData: hookData(sid, dir),
      args: ["cc-candybar", "--config-only", config],
    });

  test("a shell source keyed on another draws its first answered render with nothing pending", async () => {
    // A first request from a renderer that has not started spends its wait
    // starting it, so a request from a warm one is what waits on the sources.
    const warmDir = path.join(scratch, "warm");
    mkdirSync(warmDir);
    const warm = path.join(warmDir, "warm.json5");
    writeFileSync(
      warm,
      `{ segments: { warm: { template: "warm" } }, root: { h: ["warm"] } }`,
    );
    expect(textOf(await request("source-wait-warm", warmDir, warm))).toContain(
      "warm",
    );

    const chainDir = path.join(scratch, "chain");
    mkdirSync(chainDir);
    const chain = path.join(chainDir, "chain.json5");
    writeFileSync(
      chain,
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
    expect(textOf(await request(sid, chainDir, chain))).toContain(
      "chain=one-two",
    );
    // The client's helper asks again after a wait that ended at its deadline,
    // and refuses a pending draw from one that did not, so the render it kept
    // waited for every run its view names, the second's included.
    const [first] = await loggedLines(
      env,
      (lines) => keptRenders(lines, sid),
      (kept) => kept.length >= 1,
      `an answered render of ${sid} that was not asked again`,
    );
    expect(first).toMatch(/ pending=-(?: |$)/);
  });
});
