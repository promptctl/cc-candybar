// [LAW:verifiable-goals] brandon-config-5g8's acceptance, measured the way
// the ticket measured the defect: a REAL daemon over a REAL socket. The
// ticket set CC_CANDYBAR_CONFIG on the statusline command and saw a rejected
// config render byte-identically to no config — because the variable was
// read from the DAEMON's own environment, which the client's shell never
// reaches once a daemon is running. So this daemon is spawned with NO such
// variable, and every override arrives the only way a client can send one:
// as the `configEnv` hint, the `--config` flag, or a load-config click.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { VERB_LOAD_CONFIG } from "../src/click/wire";
import { click, killAndWait, render, stripAnsi } from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

// The argv a client sends: binary path first, as parseRenderArgs expects.
const configFlag = (p: string): string[] => ["cc-candybar", "--config", p];

describe("brandon-config-5g8: a client's CC_CANDYBAR_CONFIG reaches a running daemon", () => {
  let sockPath: string;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let daemon: RunningDaemon | undefined;
  // The shape every shipped template failed with (brandon-plugin-templates-irq):
  // a top-level key the loader does not know.
  let rejected: string;
  let absent: string;
  let override: string;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-config-env-e2e");
    sockPath = prepared.sockPath;
    removeTmpDirs = prepared.removeTmpDirs;
    // The daemon's own shell says nothing — as in production, where the
    // daemon was spawned by whichever session came first.
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

  // Three renders, three different bars:
  //   • no override — the bundled default, no strip;
  //   • an override naming a file the loader rejects — the red strip naming
  //     the file and its first issue, enough to send the user to `check`;
  //   • an override naming a file that does not exist — the bar says so, and
  //     names the path, instead of the silent default the ticket measured.
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

    expect(plain).not.toContain("Invalid config");
    expect(plain).not.toContain("Config file not found");

    expect(viaRejected).toContain("⚠ Invalid config in");
    expect(viaRejected).toContain(rejected);
    expect(viaRejected).toContain('Unknown top-level key "theme"');

    // The strip word-wraps at the client's width, so the path (one word)
    // sits on a row of its own beneath the sentence that names it.
    expect(viaAbsent).toContain("⚠ Config file not found:");
    expect(viaAbsent).toContain(absent);
    expect(viaAbsent).not.toContain("Invalid config");

    expect(viaRejected).not.toBe(plain);
    expect(viaAbsent).not.toBe(plain);
  });

  // The three spellings of an explicit config have ONE precedence, composed
  // at the request boundary (server.ts): a load-config pick over the
  // `--config` flag over the `configEnv` hint. Each render below carries the
  // two lower spellings naming DIFFERENT files, so the bar itself says which
  // one won. An empty `--config` is no override at all — the hint applies —
  // never an empty path collapsing the chain to nothing.
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
});
