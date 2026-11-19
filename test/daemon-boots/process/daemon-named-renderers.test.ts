// [LAW:verifiable-goals] A single real host launches two renderer entries,
// and observations of the same file stay at that host.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { textOf } from "../../../src/render/frame";
import { daemonArgs } from "../../../src/daemon/acquire";
import { openFrameStream } from "../../../src/daemon/client-frames";
import { PROTOCOL_VERSION } from "../../../src/daemon/foundations/protocol";
import { frameRequest, hookData, renderBody } from "../../helpers/daemon-e2e";
import { sendDaemonRequest } from "../../helpers/daemon-wire";
import { until } from "../../helpers/until";
import { TEST_ENV } from "../../helpers/session-environment";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "../../helpers/spawn-isolated-daemon";

const WORKTREE_MODEL = "Worktree renderer";

function cacheEntry(id: string, timestamp: string): string {
  return (
    JSON.stringify({
      type: "assistant",
      uuid: id,
      timestamp,
      message: {
        role: "assistant",
        content: [],
        usage: { cache_read_input_tokens: 10 },
      },
    }) + "\n"
  );
}

// The release bundle's own renderer, with one deliberately different piece
// of display code. It still exercises the production process and boot wire,
// config compiler, templates, and source subscriptions.
function worktreeBundle(file: string): void {
  const built = fs.readFileSync(
    path.join(process.cwd(), "dist", "index.mjs"),
    "utf8",
  );
  const declaration = /function composePayload\([^,]+,([^,]+),[^)]+\)\{/g;
  const matches = [...built.matchAll(declaration)];
  if (matches.length !== 1)
    throw new Error("expected one bundled payload composer");
  const [prefix, inputs] = matches[0]!;
  const changed = `${inputs}={...${inputs},hookData:{...${inputs}.hookData,model:{...${inputs}.hookData.model,display_name:${JSON.stringify(WORKTREE_MODEL)}}}};`;
  fs.writeFileSync(
    file,
    built.replace(prefix, () => prefix + changed),
  );
}

interface Read {
  readonly file: string;
  readonly pid: number;
}

// The probe counts filesystem calls for the exact
// fixture paths. Child renderers inherit the preload as well.
function readProbe(
  file: string,
  output: string,
  selected: Readonly<Record<string, readonly string[]>>,
): void {
  fs.writeFileSync(
    file,
    `
    const fs = require("node:fs");
    const fsp = require("node:fs/promises");
    const { syncBuiltinESMExports } = require("node:module");
    const wanted = ${JSON.stringify(selected)};
    const append = fs.appendFileSync;
    for (const [api, name] of [[fs,"openSync"], [fsp,"open"], [fsp,"readFile"]]) {
      const original = api[name];
      api[name] = function (file, ...rest) {
        if (typeof file === "string" && wanted[file]?.includes(name)) append(${JSON.stringify(output)}, JSON.stringify({file,pid:process.pid}) + "\\n");
        return original.call(this, file, ...rest);
      };
    }
    syncBuiltinESMExports();
  `,
  );
}

function readsOf(file: string): Read[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Read);
}

test("two named renderer processes draw separately and share config, transcript and plugin-source reads", async () => {
  const isolated = prepareIsolatedDaemonEnv("ccb-named");
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-named-fixture-")),
  );
  let daemon: RunningDaemon | undefined;
  const stopFeeds: (() => void)[] = [];
  try {
    const data = path.join(root, "data");
    const plugin = path.join(data, "cc-candybar", "plugins", "shared");
    fs.mkdirSync(plugin, { recursive: true });
    const source = path.join(plugin, "marker.txt");
    const definition = path.join(plugin, "plugin.json5");
    const config = path.join(root, "config.json5");
    const transcriptOf = (session: string) =>
      path.join(root, `${session}.jsonl`);
    const firstTranscript = transcriptOf("main-session");
    const secondTranscript = transcriptOf("secondary-session");
    const alternate = path.join(root, "worktree.mjs");
    const reads = path.join(root, "reads.jsonl");
    const probe = path.join(root, "reads.cjs");

    fs.writeFileSync(source, "one-shared-plugin-read\n");
    fs.writeFileSync(
      definition,
      `{
      variables: {
        marker: { kind: "file", path: ${JSON.stringify(source)}, cache: { watch_file: ${JSON.stringify(source)} } },
      },
      segments: { marker: { template: "{{ .plugins.shared.marker }}" } },
    }`,
    );
    fs.writeFileSync(
      config,
      `{
      globals: { experimentalStatusline: true },
      variables: {
        modelName: { kind: "input", path: "model.display_name" },
        expiry: { kind: "input", path: "cache.expiresAt" },
      },
      segments: {
        model: { template: "{{ .modelName }}" },
        expiry: { template: "{{ if .expiry }}expiry={{ .expiry }}{{ end }}" },
      },
      root: { h: ["model", "plugins.shared.marker", "expiry"] },
    }`,
    );
    for (const transcript of [firstTranscript, secondTranscript])
      fs.writeFileSync(
        transcript,
        cacheEntry("initial", "2026-11-19T12:00:00.000Z"),
      );
    worktreeBundle(alternate);
    const shared = [config, definition, source];
    readProbe(probe, reads, {
      [config]: ["openSync"],
      [definition]: ["openSync"],
      [source]: ["readFile"],
      [firstTranscript]: ["open", "openSync"],
      [secondTranscript]: ["open", "openSync"],
    });
    daemon = await spawnDaemonWithEnv(
      {
        ...isolated.env,
        XDG_DATA_HOME: data,
        NODE_OPTIONS: [isolated.env.NODE_OPTIONS, `--require=${probe}`]
          .filter(Boolean)
          .join(" "),
      },
      (env) => ({
        bin: process.execPath,
        args: daemonArgs(path.join(process.cwd(), "dist", "index.mjs"), env),
      }),
    );

    const args = ["cc-candybar", "--config", config];
    const request = (
      session: string,
      named?: { name: string; bundle: string },
      transcript = transcriptOf(session),
    ) =>
      frameRequest(isolated.sockPath, {
        ...renderBody(session, root, {}, args),
        hookData: {
          ...hookData(session, root),
          transcript_path: transcript,
        },
        ...(named !== undefined && {
          env: { ...TEST_ENV, CC_CANDYBAR_NAME: named.name },
          client: { kind: "node", bundle: named.bundle, source: null },
        }),
      });

    let primary = "";
    const expectedExpiry = (hour: string) =>
      `expiry=${Date.parse(`2026-11-19T${hour}:00:00.000Z`) / 1000}`;
    await until(
      async () => {
        primary = textOf(await request("main-session"));
        return (
          primary.includes("one-shared-plugin-read") &&
          primary.includes(expectedExpiry("13"))
        );
      },
      () => `primary plugin source was read, last frame: ${primary}`,
      8000,
    );
    expect(primary).toContain("Opus 4.7");
    expect(primary).not.toContain(WORKTREE_MODEL);
    const before = readsOf(reads);
    const count = (all: readonly Read[], file: string) =>
      all.filter((read) => read.file === file).length;
    for (const file of shared) expect(count(before, file)).toBe(1);
    expect(count(before, firstTranscript)).toBeGreaterThan(0);
    expect(count(before, secondTranscript)).toBe(0);

    const selected = { name: "worktree", bundle: alternate };
    const push = spawn(
      process.execPath,
      [alternate, "frames", "--lane", "statusline", "--config", config],
      {
        cwd: root,
        env: { ...isolated.env, CC_CANDYBAR_NAME: selected.name },
        stdio: "pipe",
      },
    );
    const pushEnded = once(push, "exit");
    let pushed = "";
    let pushErrors = "";
    push.stdout.setEncoding("utf8").on("data", (text: string) => {
      pushed += text;
    });
    push.stderr.setEncoding("utf8").on("data", (text: string) => {
      pushErrors += text;
    });
    try {
      push.stdin.write(
        JSON.stringify({
          ...hookData("secondary-session", root),
          transcript_path: secondTranscript,
        }) + "\n",
      );
      await until(
        () =>
          pushed.includes(WORKTREE_MODEL) &&
          pushed.includes("one-shared-plugin-read"),
        () => `the named statusline feed: ${pushed || pushErrors}`,
        8000,
      );
    } finally {
      push.stdin.end();
      await pushEnded;
    }
    const worktree = textOf(await request("secondary-session", selected));
    expect(worktree).toContain(WORKTREE_MODEL);
    expect(worktree).toContain("one-shared-plugin-read");
    const stillPrimary = textOf(await request("main-session"));
    expect(stillPrimary).toContain("Opus 4.7");
    expect(stillPrimary).toContain("one-shared-plugin-read");
    expect(stillPrimary).not.toContain(WORKTREE_MODEL);
    const both = readsOf(reads);
    for (const file of shared) expect(count(both, file)).toBe(1);
    expect(count(both, firstTranscript)).toBe(count(before, firstTranscript));
    expect(count(both, secondTranscript)).toBeGreaterThan(0);

    // An existing Claude session can move to another renderer. Its
    // transcript and source keys stay held by the same host.
    expect(textOf(await request("main-session", selected))).toContain(
      WORKTREE_MODEL,
    );
    expect(textOf(await request("secondary-session", selected))).toContain(
      WORKTREE_MODEL,
    );
    expect(readsOf(reads)).toEqual(both);
    expect(new Set(both.map((read) => read.pid))).toEqual(
      new Set([daemon.child.pid]),
    );

    // A different Claude session, served by the worktree, names the same
    // transcript as the main process. Both consume the host's cache at the
    // current file version and again after an append.
    expect(textOf(await request("main-session"))).toContain("Opus 4.7");
    let alias = "";
    await until(
      async () => {
        alias = textOf(
          await request("alias-session", selected, firstTranscript),
        );
        return alias.includes(expectedExpiry("13"));
      },
      () => `the worktree showed no expiry for the shared transcript: ${alias}`,
      8000,
    );
    expect(alias).toContain(WORKTREE_MODEL);
    const beforeAppend = count(readsOf(reads), firstTranscript);
    expect(beforeAppend).toBe(count(both, firstTranscript));
    fs.appendFileSync(
      firstTranscript,
      cacheEntry("updated", "2026-11-19T14:00:00.000Z"),
    );
    await until(
      async () => {
        const [standard, alternative] = await Promise.all([
          request("main-session"),
          request("alias-session", selected, firstTranscript),
        ]);
        return [standard, alternative].every((frame) =>
          textOf(frame).includes(expectedExpiry("15")),
        );
      },
      () => "both renderers to observe the appended transcript entry",
      10_000,
    );
    expect(count(readsOf(reads), firstTranscript)).toBe(beforeAppend + 2);

    const follow = (session: string) => {
      const frames: string[] = [];
      const stream = openFrameStream(
        isolated.sockPath,
        session,
        "statusline",
        (frame) => {
          if (frame.ok && "output" in frame && typeof frame.output === "string")
            frames.push(frame.output);
        },
        () => {},
      );
      stopFeeds.push(() => stream.close());
      return frames;
    };
    const standard = follow("main-session");
    const alternative = follow("secondary-session");
    const delivered = (contents: string) =>
      standard.some(
        (frame) => frame.includes("Opus 4.7") && frame.includes(contents),
      ) &&
      alternative.some(
        (frame) => frame.includes(WORKTREE_MODEL) && frame.includes(contents),
      );
    const updatedSource = "one-shared-plugin-refresh";
    await until(
      () => delivered("one-shared-plugin-read"),
      "both pushed frames",
    );
    const priorReads = count(readsOf(reads), source);
    fs.writeFileSync(source, `${updatedSource}\n`);
    // Both draw from the same file refresh, without another statusline
    // request re-admitting either renderer's subscriptions.
    await until(
      () => delivered(updatedSource),
      "both pushed frames to observe one source invalidation",
      10_000,
    );
    expect(count(readsOf(reads), source)).toBe(priorReads + 1);

    const conflict = await sendDaemonRequest(
      isolated.sockPath,
      {
        ...renderBody("conflicting-session", root, {}, args),
        v: PROTOCOL_VERSION,
        kind: "render",
        env: { ...TEST_ENV, CC_CANDYBAR_NAME: selected.name },
        client: {
          kind: "node",
          bundle: path.join(process.cwd(), "dist", "index.mjs"),
          source: null,
        },
      },
      1000,
    );
    expect(conflict).toMatchObject({
      ok: false,
      error: expect.stringContaining("renderer worktree is bound"),
    });

    const stats = await sendDaemonRequest(
      isolated.sockPath,
      { v: PROTOCOL_VERSION, kind: "stats" },
      1000,
    );
    expect(stats).toMatchObject({ ok: true, stats: { pid: daemon.child.pid } });
    const readLog = () =>
      fs.readFileSync(path.join(isolated.stateDir, "daemon.log"), "utf8");
    const children = [
      ...readLog().matchAll(/renderer (main|worktree)\[1\] started pid=(\d+)/g),
    ];
    expect(children.map((match) => match[1]).sort()).toEqual([
      "main",
      "worktree",
    ]);
    expect(new Set(children.map((match) => Number(match[2]))).size).toBe(2);
    expect(children.map((match) => Number(match[2]))).not.toContain(
      daemon.child.pid,
    );

    const worktreePid = Number(
      children.find((match) => match[1] === "worktree")?.[2],
    );
    if (!Number.isSafeInteger(worktreePid) || worktreePid < 1)
      throw new Error("expected the worktree renderer's live child pid");
    process.kill(worktreePid, "SIGKILL");
    const afterEnd = "main-feed-survives-worktree-end";
    fs.writeFileSync(source, `${afterEnd}\n`);
    await until(
      () =>
        standard.some((frame) => frame.includes(afterEnd)) &&
        /renderer worktree\[2\] started pid=/.test(readLog()),
      "the primary feed stays live during worktree recovery",
      8000,
    );
    expect(readLog().match(/renderer main\[\d+\] started pid=/g)).toHaveLength(
      1,
    );
  } finally {
    for (const stop of stopFeeds) stop();
    await daemon?.stop();
    isolated.removeTmpDirs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
