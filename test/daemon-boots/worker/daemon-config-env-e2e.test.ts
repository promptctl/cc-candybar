// [LAW:verifiable-goals] brandon-config-5g8's acceptance. The ticket set
// CC_CANDYBAR_CONFIG on the statusline command and saw a rejected config render
// byte-identically to no config — because the variable was read from the
// DAEMON's own environment, which the client's shell never reaches once a
// daemon is running. So this daemon is given NO such variable, and every
// override arrives the only way a client can send one: as the `configEnv` hint
// or the `--config` flag.

import { textOf } from "../../../src/render/frame";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { VERB_SET_CONFIG } from "../../../src/click/wire";
import { renderLines } from "../../helpers/daemon-log";
import { click, configFlag, hookData, render as renderBar, renderRequest } from "../../helpers/daemon-e2e";
import type { DaemonTarget } from "../../helpers/daemon-wire";
import { readDiagnostics } from "../../helpers/diagnostics-viewer";
import { startDaemon, type InWorkerDaemon } from "../../helpers/in-worker-daemon";
import type { ClientHints } from "../../../src/daemon/protocol";
import {
  prepareIsolatedDaemonEnv,
} from "../../helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

// What a person reads of a session's bar: the bar, then every message its
// indicator offers, each read in the viewer.
async function render(
  target: DaemonTarget,
  sessionId: string,
  cwd: string,
  hints: ClientHints = {},
  args: string[] = [],
): Promise<string> {
  const bar = await renderBar(target, sessionId, cwd, hints, args);
  const pages = await readDiagnostics(target, sessionId, cwd, bar, hints, args);
  return [textOf(bar), ...pages.map((p) => p.text)].join("\n");
}

describe("brandon-config-5g8: a client's CC_CANDYBAR_CONFIG reaches a running daemon", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let daemon: InWorkerDaemon;
  // The shape every shipped template failed with (brandon-plugin-templates-irq):
  // a top-level key the loader does not know.
  let rejected: string;
  let absent: string;
  let override: string;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-config-env-e2e");
    env = prepared.env;
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
    daemon = startDaemon(prepared.env);
  });

  afterAll(async () => {
    await daemon?.stop();
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  // Four renders, four different bars:
  //   • no override — the bundled default, no strip;
  //   • an override naming a valid file — that file's own bar, no strip;
  //   • an override naming a file the loader rejects — the bar's error naming
  //     the file and its first issue, enough to send the user to `check`;
  //   • an override naming a file that does not exist — the bar says so, and
  //     names the path, instead of the silent default the ticket measured.
  test("a rejected override and an absent override are each visibly distinct from no override", async () => {
    const plain = await render(daemon, "cfg-env-plain", projectDir);
    const viaRejected = await render(daemon, "cfg-env-rejected", projectDir, {
      configEnv: rejected,
    });
    const viaAbsent = await render(daemon, "cfg-env-absent", projectDir, {
      configEnv: absent,
    });

    const viaValid = await render(daemon, "cfg-env-valid", projectDir, {
      configEnv: override,
    });

    expect(plain).not.toContain("Invalid config");
    expect(plain).not.toContain("Config file not found");

    expect(viaValid).toContain("OVERRIDE-WINS");
    expect(viaValid).not.toContain("Invalid config");
    expect(viaValid).not.toContain("Config file not found");

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

  // brandon-unfiled-3248.8bz: a bare `--config` (only ever the last token —
  // the flag takes whatever follows it) was read as no override, silently,
  // even when an earlier `--config` named a file. It is refused as the bar's error
  // and on the render event, like an unknown flag or a stray word, and the
  // bar renders with no --config.
  test("a bare --config is refused on the bar and the render event, not silently dropped", async () => {
    const bare = await render(daemon, "cfg-flag-bare", projectDir, {}, [
      "cc-candybar",
      "--config",
    ]);
    expect(bare).toContain(
      "--config names no file — the bar renders with no --config",
    );

    const lastBare = await render(daemon, "cfg-flag-last-bare", projectDir, {}, [
      ...configFlag(override),
      "--config",
    ]);
    expect(lastBare).toContain(
      "--config names no file — the bar renders with no --config",
    );
    expect(lastBare).not.toContain("OVERRIDE-WINS");

    const unknown = await render(daemon, "cfg-flag-unknown", projectDir, {}, [
      ...configFlag(override),
      "--bogus",
      "--bogus",
    ]);
    expect(unknown).toContain("Unknown flags: --bogus");
    expect(unknown).not.toContain("names no file");
    expect(unknown).toContain("OVERRIDE-WINS");

    const positional = await render(
      daemon,
      "cfg-flag-positional",
      projectDir,
      {},
      [...configFlag(override), "stray.json5"],
    );
    expect(positional).toContain("Unexpected arguments: stray.json5");
    expect(positional).toContain("OVERRIDE-WINS");

    await render(
      daemon,
      "cfg-flag-clean",
      projectDir,
      {},
      configFlag(override),
    );
    // Each distinct value its renders' events name: reading the bar's messages
    // renders it again, and every render names the same.
    const badArgsOf = async (sid: string) => [
      ...new Set(
        (await renderLines(env, sid)).map((l) => l.match(/ badArgs=(\S+) /)?.[1]),
      ),
    ];
    expect(await badArgsOf("cfg-flag-bare")).toEqual(["--config:no-value"]);
    expect(await badArgsOf("cfg-flag-last-bare")).toEqual(["--config:no-value"]);
    expect(await badArgsOf("cfg-flag-unknown")).toEqual(["--bogus:unknown"]);
    expect(await badArgsOf("cfg-flag-positional")).toEqual([
      "stray.json5:positional",
    ]);
    expect(await badArgsOf("cfg-flag-clean")).toEqual(["-"]);
  });

  // brandon-config-nuq6: `--config` arrives as the client's raw argv, so a
  // relative path is resolved against the cwd the client reported, never the
  // daemon's own.
  test("a relative --config resolves against the client's cwd", async () => {
    const bar = await render(
      daemon,
      "cfg-flag-relative",
      projectDir,
      {},
      configFlag(path.basename(override)),
    );
    expect(bar).toContain("OVERRIDE-WINS");
    expect(bar).not.toContain("Config file not found");
  });

  // brandon-config-nuq6: a client older than the daemon sends the variable
  // raw. The checkpoint refuses it — the daemon would read it against its own
  // cwd — and the bar says so rather than rendering another config unexplained.
  test("a relative configEnv hint is refused on the bar, not resolved against the daemon's cwd", async () => {
    const bar = await render(daemon, "cfg-env-stale-client", projectDir, {
      configEnv: path.basename(override),
    });
    expect(bar).toContain('Client hints refused: configEnv="override.json5"');
    expect(bar).not.toContain("OVERRIDE-WINS");
    // The render event names what was refused; a render that refused nothing
    // says `-`, so "none refused" and "not logged" stay distinct.
    await render(daemon, "cfg-env-taken", projectDir, {
      configEnv: override,
    });
    const refusedOf = async (sid: string) =>
      (await renderLines(env, sid)).map((l) => l.match(/ refused=(\S+) /)?.[1]);
    // Reading the bar's messages renders it again: every render refused it.
    expect(new Set(await refusedOf("cfg-env-stale-client"))).toEqual(
      new Set(["configEnv"]),
    );
    expect(await refusedOf("cfg-env-taken")).toEqual(["-"]);
  });

  // The request's cwd anchors a relative --config, so a relative cwd is a
  // frame no client of ours builds: refused, never anchored at the daemon's.
  test("a render request whose cwd is not absolute is a bad request", async () => {
    await expect(
      renderRequest(daemon, {
        hookData: hookData("cfg-relative-cwd", projectDir),
        args: configFlag("override.json5"),
        cwd: "proj",
      }),
    ).rejects.toThrow(/request 'cwd' is not an absolute path: "proj".*BAD_REQUEST/);
  });
});
