import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { decodeFromCompressedBase64 } from "hdr-histogram-js";

import { linksOf } from "../../../src/click/read";
import { parseJson5Syntax } from "../../../src/config/loader/diagnostics";
import { daemonArgs } from "../../../src/daemon/acquire";
import { textOf, type WireFrame } from "../../../src/render/frame";
import type { RecordingEntry } from "../../../src/renderer-interface/recording";
import { replayRecording } from "../../../src/renderer/replay";
import { click, frameRequest, observePane, renderBody } from "../../helpers/daemon-e2e";
import { prepareIsolatedDaemonEnv } from "../../../scripts/lib/daemon/isolated";
import { spawnDaemonWithEnv } from "../../helpers/spawn-isolated-daemon";
import { until } from "../../../scripts/lib/until";

const exec = promisify(execFile);
const BUNDLE = path.resolve("dist/index.mjs");
const ENV_NAME = "CCB_RECORDING_TEST_VALUE";
const ENV_VALUE = "only-the-live-bar-may-see-this";
const LOCALIZED = "50.000 1969-12-31 19:00 -0500";

function replayedFrames(stdout: string): readonly {
  readonly session: string;
  readonly surface: "statusline" | "pane";
  readonly frame: WireFrame;
}[] {
  return stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
}

test("the running host records two independent renderer sessions for offline replay", async () => {
  const isolated = prepareIsolatedDaemonEnv("ccb-record");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-recording-"));
  let daemon: Awaited<ReturnType<typeof spawnDaemonWithEnv>> | undefined;
  try {
    const project = path.join(dir, "project");
    const relocated = path.join(dir, "relocated");
    fs.mkdirSync(project);
    fs.mkdirSync(relocated);
    const alternate = path.join(relocated, "index.mjs");
    fs.copyFileSync(BUNDLE, alternate);
    const mainCapture = path.join(dir, "main.jsonl");
    const namedCapture = path.join(dir, "worktree.jsonl");
    const refusedCapture = path.join(dir, "refused.jsonl");
    const config = path.join(project, "config.json5");
    const original = JSON.stringify({
      globals: { experimentalPane: true, padding: 1 },
      actions: {
        wider: { persist: "padding", min: 0, max: 4, by: 1, layer: "user" },
        remember: { set: "remembered", to: "saved-by-click" },
      },
      variables: { remembered: { kind: "state", key: "remembered", default: "empty" } },
      segments: {
        sample: {
          template: 'recorded-source padding={{ .padding.effective }} {{ action "wider" "WIDER" }} {{ frames 0.1 "phase-a" 0.1 "phase-b" }} {{ .remembered }} {{ action "remember" "REMEMBER" }} {{ formatInteger 50000 }} {{ date "2006-01-02 15:04 -0700" 0 }}',
        },
      },
      root: { h: ["sample"] },
    });
    fs.writeFileSync(config, original);
    const privateConfig = path.join(project, "private.json5");
    fs.writeFileSync(privateConfig, JSON.stringify({
      variables: { watched: { kind: "env", name: ENV_NAME } },
      segments: { sample: { template: "private={{ .watched }}" } },
      root: { h: ["sample"] },
    }));
    const command = (...args: string[]) => exec(process.execPath, [BUNDLE, ...args], {
      cwd: dir,
      env: { ...isolated.env, CC_CANDYBAR_NAME: undefined },
      timeout: 10_000,
    });
    const draw = (session: string, file = config, renderer?: string) =>
      frameRequest(isolated.sockPath, {
        ...renderBody(session, project, { termCols: 160 }, ["cc-candybar", "--config", file]),
        env: {
          [ENV_NAME]: ENV_VALUE,
          ...(renderer === undefined ? {} : { CC_CANDYBAR_NAME: renderer }),
        },
        ...(renderer === undefined ? {} : {
          client: { kind: "node", bundle: alternate, source: null },
        }),
      });
    const liveLog = () => fs.readFileSync(path.join(isolated.stateDir, "daemon.log"), "utf8");
    const mainStarts = () => Array.from(
      liveLog().matchAll(/renderer main\[\d+\] started pid=(\d+)/g), (match) => match[1],
    );

    const liveEnv = { ...isolated.env, LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", TZ: "America/New_York" };
    daemon = await spawnDaemonWithEnv(liveEnv, (env) => ({
      bin: process.execPath,
      args: daemonArgs(BUNDLE, env),
    }));
    const primarySession = "recorded-primary";
    const namedSession = "recorded-worktree";
    expect(textOf(await draw(primarySession))).toContain("recorded-source padding=1");
    const first = mainStarts();
    expect(first).toHaveLength(1);

    await command("record", "start", path.basename(mainCapture));
    await command("record", "start", namedCapture, "--renderer", "worktree");
    const frame = await draw(primarySession);
    expect(textOf(frame)).toContain("recorded-source padding=1");
    expect(textOf(frame)).toContain(LOCALIZED);
    const afterStart = mainStarts();
    expect(afterStart).toHaveLength(2);
    expect(afterStart[1]).not.toBe(first[0]);

    const named = await draw(namedSession, config, "worktree");
    expect(textOf(named)).toContain("recorded-source padding=1");
    expect(textOf(named)).toContain(LOCALIZED);
    const links = linksOf(named);
    const wider = links.find(({ text }) => text === "WIDER");
    const remember = links.find(({ text }) => text === "REMEMBER");
    if (wider === undefined || remember === undefined)
      throw new Error("recorded statusline showed no config or state control");
    await click(isolated.sockPath, wider.url);
    await click(isolated.sockPath, remember.url);
    const edited = fs.readFileSync(config, "utf8");
    expect(parseJson5Syntax(edited)).toMatchObject({ kind: "parsed", value: { globals: { padding: 2 } } });
    const pane = observePane(isolated.sockPath, namedSession);
    try {
      const phase = (name: string) => pane.waitFor(
        (line) => line.includes("padding=2") && line.includes(name) && line.includes("saved-by-click"),
        `the pane phase ${name} showing the signed clicks' config and state changes`,
      );
      await phase("phase-a");
      await phase("phase-b");
      fs.writeFileSync(config, edited.replace("recorded-source", "reloaded-source"));
      await pane.waitFor((line) => line.includes("reloaded-source"), "the config watch reload in the pane");
    } finally {
      pane.close();
    }
    await until(() => liveLog().includes(`feed sid="${namedSession}" closed`), "the closing pane's renderer diagnostic");

    await command("record", "stop", "--renderer", "worktree");
    await command("record", "stop");
    expect(mainStarts()).toEqual(afterStart);
    const captured = fs.readFileSync(namedCapture, "utf8");
    expect(captured).not.toContain(ENV_NAME);
    expect(captured).not.toContain(ENV_VALUE);

    await command("record", "start", refusedCapture, "--renderer", "private");
    let current = "";
    await until(async () => {
      current = textOf(await draw("recorded-private", privateConfig, "private"));
      return current.includes(`private=${ENV_VALUE}`);
    }, () => `the configured env variable in the live bar (${current})`);
    await expect(command("record", "stop", "--renderer", "private")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/env/i),
    });
    expect(fs.existsSync(refusedCapture)).toBe(false);
    expect(textOf(await draw("recorded-private", privateConfig, "private"))).toContain(`private=${ENV_VALUE}`);

    const shutdownCapture = path.join(dir, "shutdown.jsonl");
    await command("record", "start", shutdownCapture);
    expect(textOf(await draw(primarySession))).toContain("reloaded-source");
    expect(fs.existsSync(shutdownCapture)).toBe(false);

    // The replay bundle runs from another directory, after the host and its
    // authored inputs are gone. It can only draw from the recorded turns.
    // The host handles SIGHUP and drains its workers through their mailboxes.
    expect(await daemon.stop("SIGHUP")).toEqual({ code: 0, signal: null });
    daemon = undefined;
    fs.rmSync(project, { recursive: true });
    const replayEnv = { ...isolated.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TZ: "UTC" };
    const replay = (file: string, bundle: string) => exec(process.execPath, [bundle, "replay", file, "--frames"], {
      cwd: relocated,
      env: replayEnv,
      timeout: 10_000,
    });
    const primaryReplay = await replay(mainCapture, alternate);
    const shutdownReplay = await replay(shutdownCapture, alternate);
    expect(replayedFrames(shutdownReplay.stdout).some(({ frame }) => textOf(frame).includes("reloaded-source"))).toBe(true);
    const primaryFrames = replayedFrames(primaryReplay.stdout);
    expect(new Set(primaryFrames.map(({ session }) => session))).toEqual(new Set([primarySession]));
    expect(primaryFrames.some(({ frame }) => textOf(frame).includes("recorded-source padding=1"))).toBe(true);
    expect(primaryFrames.some(({ frame }) => textOf(frame).includes(LOCALIZED))).toBe(true);
    const namedReplay = await replay(namedCapture, BUNDLE);
    const frames = replayedFrames(namedReplay.stdout);
    expect(new Set(frames.map(({ session }) => session))).toEqual(new Set([namedSession]));
    expect(frames.some(({ surface, frame }) => surface === "statusline" && textOf(frame).includes("recorded-source padding=1"))).toBe(true);
    expect(frames.some(({ surface, frame }) => surface === "statusline" && textOf(frame).includes(LOCALIZED))).toBe(true);
    const panes = frames.filter(({ surface }) => surface === "pane").map(({ frame }) => textOf(frame));
    expect(panes).toEqual(expect.arrayContaining([
      expect.stringContaining("recorded-source padding=2 WIDER phase-a saved-by-click"),
      expect.stringContaining("recorded-source padding=2 WIDER phase-b saved-by-click"),
      expect.stringContaining("reloaded-source"),
    ]));

    const records: RecordingEntry[] = captured.trimEnd().split("\n").map((line) => JSON.parse(line));
    const histogram = records.flatMap((record) => record.kind === "turn" ? record.output.diagnostics ?? [] : [])
      .map(({ line }) => /(?:^| )latenessHistogram=(\S+)/.exec(line)?.[1])
      .find((value) => value !== undefined);
    if (histogram === undefined) throw new Error("the recorded pane close emitted no histogram");
    expect(decodeFromCompressedBase64(histogram).totalCount).toBeGreaterThan(0);
    // The checked-in core and the shipped bundle must agree on the actual
    // diagnostic bytes, including the closed pane's encoded distribution.
    await expect(replayRecording(captured.trimEnd().split("\n"))).resolves.toEqual({ turns: records.length - 2 });
    const firstDraw = records.findIndex((entry) => entry.kind === "turn" && entry.output.effects.some(({ kind }) => kind === "present"));
    const entry = records[firstDraw];
    if (entry?.kind !== "turn") throw new Error("the recording contains no statusline presentation");
    const altered = records.map((record, index) => index === firstDraw
      ? { ...entry, output: { ...entry.output, wake: entry.output.wake === null ? 999 : null } }
      : record);
    const bad = path.join(dir, "altered.jsonl");
    fs.writeFileSync(bad, altered.map((record) => JSON.stringify(record)).join("\n") + "\n");
    await expect(replay(bad, BUNDLE)).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining(`recording turn ${firstDraw} differs at output.wake`),
    });
  } finally {
    try {
      await daemon?.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      isolated.removeTmpDirs();
    }
  }
});
