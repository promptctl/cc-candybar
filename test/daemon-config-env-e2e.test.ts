// [LAW:verifiable-goals] A REAL daemon over a REAL socket, spawned with NO
// CC_CANDYBAR_CONFIG: every override must arrive the only way a client can send
// one — the `configEnv` hint, the `--config` flag, or a load-config click.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { VERB_LOAD_CONFIG } from "../src/click/wire";
import {
  click,
  hookData,
  killAndWait,
  render,
  stripAnsi,
} from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

// Binary path first, as parseRenderArgs expects.
const configFlag = (p: string): string[] => ["cc-candybar", "--config", p];

describe("brandon-config-5g8: a client's CC_CANDYBAR_CONFIG reaches a running daemon", () => {
  let sockPath: string;
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let daemon: RunningDaemon | undefined;
  let rejected: string;
  let absent: string;
  let override: string;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-config-env-e2e");
    sockPath = prepared.sockPath;
    env = prepared.env;
    removeTmpDirs = prepared.removeTmpDirs;
    // The daemon's own shell says nothing, as in production.
    delete prepared.env.CC_CANDYBAR_CONFIG;
    projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-config-env-e2e-project-"),
    );
    rejected = path.join(projectDir, "rejected.json5");
    writeFileSync(rejected, JSON.stringify({ theme: "dracula" }));
    absent = path.join(projectDir, "absent.json5");
    override = path.join(projectDir, "override.json5");
    writeFileSync(
      override,
      `{ segments: { a: { template: 'OVERRIDE-WINS' } }, root: { h: ['a'] } }`,
    );
    daemon = await spawnDaemonWithEnv(prepared.env);
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  // Four renders, four visibly different bars.
  test("a rejected override and an absent override are each visibly distinct from no override", async () => {
    const plain = stripAnsi(
      await render(sockPath, "cfg-env-plain", projectDir),
    );
    const viaRejected = stripAnsi(
      await render(sockPath, "cfg-env-rejected", projectDir, {
        configEnv: rejected,
      }),
    );
    const viaAbsent = stripAnsi(
      await render(sockPath, "cfg-env-absent", projectDir, {
        configEnv: absent,
      }),
    );

    const viaValid = stripAnsi(
      await render(sockPath, "cfg-env-valid", projectDir, {
        configEnv: override,
      }),
    );

    expect(plain).not.toContain("Invalid config");
    expect(plain).not.toContain("Config file not found");

    expect(viaValid).toContain("OVERRIDE-WINS");
    expect(viaValid).not.toContain("Invalid config");
    expect(viaValid).not.toContain("Config file not found");

    expect(viaRejected).toContain("⚠ Invalid config in");
    expect(viaRejected).toContain(rejected);
    expect(viaRejected).toContain('Unknown top-level key "theme"');

    expect(viaAbsent).toContain("⚠ Config file not found:");
    expect(viaAbsent).toContain(absent);
    expect(viaAbsent).not.toContain("Invalid config");

    expect(viaRejected).not.toBe(plain);
    expect(viaAbsent).not.toBe(plain);
  });

  // Each render carries the two lower spellings naming DIFFERENT files, so the
  // bar itself says which won. An empty `--config` is no override at all.
  test("a load-config pick outranks --config, which outranks the configEnv hint; an empty flag is no flag", async () => {
    const sid = "cfg-env-precedence";
    const hints = { configEnv: absent };

    const flagOverHint = stripAnsi(
      await render(sockPath, sid, projectDir, hints, configFlag(rejected)),
    );
    expect(flagOverHint).toContain("⚠ Invalid config in");
    expect(flagOverHint).toContain(rejected);
    expect(flagOverHint).not.toContain("Config file not found");

    const emptyFlag = stripAnsi(
      await render(sockPath, sid, projectDir, hints, configFlag("")),
    );
    expect(emptyFlag).toContain("⚠ Config file not found:");
    expect(emptyFlag).toContain(absent);
    expect(emptyFlag).not.toContain("Invalid config");

    await click(
      sockPath,
      `cc-candybar://${VERB_LOAD_CONFIG}/${encodeURIComponent(sid)}/${encodeURIComponent(override)}`,
    );
    const pickOverBoth = stripAnsi(
      await render(sockPath, sid, projectDir, hints, configFlag(rejected)),
    );
    expect(pickOverBoth).toContain("OVERRIDE-WINS");
    expect(pickOverBoth).not.toContain("Invalid config");
    expect(pickOverBoth).not.toContain("Config file not found");
  });

  // The production wiring end to end, through the real staged bundle.
  test("the real client carries its own CC_CANDYBAR_CONFIG to the daemon", async () => {
    const sid = "cfg-env-real-client";
    // Warm the entry: the client's one bounded request has no next tick to
    // retry on. It is spawned in projectDir so it hits the entry warmed here.
    await render(sockPath, sid, projectDir, { configEnv: override });
    const client = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "dist", "index.mjs")],
      {
        cwd: projectDir,
        env: { ...env, CC_CANDYBAR_CONFIG: override },
        input: JSON.stringify(hookData(sid, projectDir)),
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(client.status).toBe(0);
    const bar = stripAnsi(client.stdout);
    expect(bar).toContain("OVERRIDE-WINS");
    expect(bar).not.toContain("Invalid config");
    expect(bar).not.toContain("Config file not found");
  });
});
