// [LAW:verifiable-goals] A single real host launches two renderer entries,
// and observations of the same file stay at that host.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { textOf } from "../../../src/render/frame";
import { daemonArgs } from "../../../src/daemon/acquire";
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
        marker: { kind: "file", path: ${JSON.stringify(source)}, cache: { ttl: "60s" } },
      },
      segments: { marker: { template: "{{ .plugins.shared.marker }}" } },
    }`,
    );
    fs.writeFileSync(
      config,
      `{
      globals: { experimentalStatusline: true },
      variables: { modelName: { kind: "input", path: "model.display_name" } },
      segments: { model: { template: "{{ .modelName }}" } },
      root: { h: ["model", "plugins.shared.marker"] },
    }`,
    );
    for (const transcript of [firstTranscript, secondTranscript])
      fs.writeFileSync(
        transcript,
        JSON.stringify({
          type: "user",
          uuid: "one",
          message: { role: "user", content: "transcript data" },
        }) + "\n",
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
    ) =>
      frameRequest(isolated.sockPath, {
        ...renderBody(session, root, {}, args),
        hookData: {
          ...hookData(session, root),
          transcript_path: transcriptOf(session),
        },
        ...(named !== undefined && {
          env: { ...TEST_ENV, CC_CANDYBAR_NAME: named.name },
          client: { kind: "node", bundle: named.bundle, source: null },
        }),
      });

    let primary = "";
    await until(
      async () => {
        primary = textOf(await request("main-session"));
        return primary.includes("one-shared-plugin-read");
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

    expect(textOf(await request("main-session"))).toContain("Opus 4.7");
    const worktreePid = Number(
      children.find((match) => match[1] === "worktree")?.[2],
    );
    if (!Number.isSafeInteger(worktreePid) || worktreePid < 1)
      throw new Error("expected the worktree renderer's live child pid");
    process.kill(worktreePid, "SIGKILL");
    let afterEnd = "";
    await until(
      async () => {
        afterEnd = textOf(await request("main-session"));
        return (
          afterEnd.includes("Opus 4.7") &&
          afterEnd.includes("one-shared-plugin-read") &&
          /renderer worktree\[2\] started pid=/.test(readLog())
        );
      },
      () =>
        `the primary did not keep drawing during worktree recovery: ${afterEnd}`,
      8000,
    );
    expect(readLog().match(/renderer main\[\d+\] started pid=/g)).toHaveLength(
      1,
    );
  } finally {
    await daemon?.stop();
    isolated.removeTmpDirs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
