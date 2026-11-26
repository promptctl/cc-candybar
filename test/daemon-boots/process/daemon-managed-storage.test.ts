import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decodeAnsi } from "@promptctl/rich-js";
import { daemonArgs } from "../../../src/daemon/acquire";
import {
  openFrameStream,
  type StreamEnd,
} from "../../../src/daemon/client-frames";
import { fieldOf, valueOf } from "../../../src/utils/logfmt";
import { frameRequest, renderBody } from "../../helpers/daemon-e2e";
import { logLines } from "../../../scripts/lib/daemon/log";
import { TEST_ENV } from "../../helpers/session-environment";
import { type RunningDaemon } from "../../../scripts/lib/daemon/isolated";
import { prepareIsolatedDaemonEnv, spawnDaemonWithEnv } from "../../helpers/spawn-isolated-daemon";
import { until } from "../../../scripts/lib/until";
import { readProbe, readsOf } from "../../helpers/daemon-read-probe";
import { untilHeard } from "../../helpers/reload-signal";

// [LAW:no-ambient-temporal-coupling] Hold the next named child before the
// actual renderer takes its boot. The host's restart delay cannot race the
// write or its watch delivery, even on a loaded runner.
async function rendererBootGate(entry: string, bundle: string, socket: string) {
  fs.writeFileSync(
    entry,
    `import { once } from "node:events";
     import { createConnection } from "node:net";
     const gate = createConnection(${JSON.stringify(socket)});
     const [open] = await once(gate, "data");
     gate.destroy();
     if (open.toString() !== "1") throw new Error("renderer boot gate refused");
     await import(${JSON.stringify(pathToFileURL(bundle).href)});`,
  );
  let open = true;
  const waiting = new Set<net.Socket>();
  const server = net.createServer((child) => {
    child.on("error", () => child.destroy());
    if (open) child.end("1");
    else {
      waiting.add(child);
      child.once("close", () => void waiting.delete(child));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(socket, resolve);
  });
  return {
    hold: () => void (open = false),
    held: () => waiting.size > 0,
    release: () => {
      open = true;
      for (const child of waiting) child.end("1");
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const child of waiting) child.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

test.each(["valid", "invalid"] as const)(
  "two renderers keep one managed watch across a restart with %s config input",
  sharedStorageAcrossRestart,
  30_000,
);

async function sharedStorageAcrossRestart(configAtRestart: "valid" | "invalid") {
  const isolated = prepareIsolatedDaemonEnv("ccb-managed");
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-managed-plugin-")),
  );
  const bundle = path.resolve("dist/index.mjs");
  const namedBundle = path.join(root, "named-bundle.mjs");
  const entry = path.join(root, "worktree.mjs");
  const definition = path.join(root, "p", "plugin.json5");
  const folder = path.join(root, "p", "session");
  const primary = "managed-main";
  const worktree = "managed-worktree";
  const ioLog = path.join(root, "reads.jsonl");
  const probe = path.join(root, "reads.cjs");
  const env = {
    ...isolated.env,
    NODE_OPTIONS: [isolated.env.NODE_OPTIONS, `--require=${probe}`]
      .filter(Boolean)
      .join(" "),
    HOME: root,
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_DATA_DIRS: path.join(root, "packaged"),
  };
  const log = () => logLines(env);
  const watches = (lines: readonly string[], state: "opened" | "closed") =>
    lines.filter((line) =>
      line.includes(`] dir watch ${state} path=${valueOf(folder)} `),
    );
  const sourceFile = (session: string) =>
    path.join(folder, `${session}.json`);
  const reads = (lines: readonly string[], session: string) =>
    lines.filter((line) =>
      line.includes(
        `] plugin storage refresh file=${valueOf(sourceFile(session))} `,
      ),
    );
  const declares = (lines: readonly string[], session: string) =>
    lines.filter((line) =>
      line.includes(`] session declared sid=${JSON.stringify(session)} `),
    );
  const config = (session: string) => path.join(root, `${session}.json5`);
  const configure = (session: string, needsPlugin: boolean) =>
    fs.writeFileSync(
      config(session),
      JSON.stringify({
        globals: { experimentalStatusline: true },
        ...(needsPlugin ? { plugins: [definition] } : {}),
        segments: { removed: { template: `removed ${session}` } },
        root: { h: [needsPlugin ? "plugins.p.marker" : "removed"] },
      }),
    );
  // The plugin writer's contract is to publish a complete JSON document by rename.
  const write = (session: string, marker: string) => {
    const temporary = path.join(folder, `.${session}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify({ marker }));
    fs.renameSync(temporary, sourceFile(session));
  };
  let daemon: RunningDaemon | undefined;
  let gate: Awaited<ReturnType<typeof rendererBootGate>> | undefined;
  const stopFeeds: (() => void)[] = [];
  try {
    for (const dir of [
      path.dirname(definition),
      env.CLAUDE_CONFIG_DIR,
      env.XDG_DATA_HOME,
      env.XDG_DATA_DIRS,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      definition,
      `{
    sources: { status: { scope: "session", refresh: { watch: true }, read: { file: { json: true } } } },
    segments: { marker: { template: "{{ .plugins.p.status.marker }}" } }
  }`,
    );
    for (const session of [primary, worktree]) configure(session, true);
    readProbe(probe, ioLog, {
      [definition]: ["payload"],
      [config(primary)]: ["payload"],
      [config(worktree)]: ["payload"],
      [sourceFile(primary)]: ["readFile"],
      [sourceFile(worktree)]: ["readFile"],
    });
    fs.copyFileSync(bundle, namedBundle);
    gate = await rendererBootGate(
      entry,
      namedBundle,
      path.join(isolated.stateDir, "gate"),
    );
    daemon = await spawnDaemonWithEnv(env, (inherited) => ({
      bin: process.execPath,
      args: daemonArgs(bundle, inherited),
    }));
    for (const session of [primary, worktree]) {
      const request = {
        ...renderBody(session, root, { termCols: 300 }, [
          "cc-candybar",
          "--config-only",
          config(session),
        ]),
        ...(session === worktree && {
          env: { ...TEST_ENV, CC_CANDYBAR_NAME: "worktree" },
          client: { kind: "node" as const, bundle: entry, source: null },
        }),
      };
      await frameRequest(isolated.sockPath, request);
      await until(
        () => fs.existsSync(folder),
        "the host to provision plugin storage",
      );
    }

    // From here on both views are driven by real subscriptions and writes.
    const follow = (session: string) => {
      const frames = new Set<string>();
      let ended: StreamEnd | undefined;
      const stream = openFrameStream(
        isolated.sockPath,
        session,
        "statusline",
        (frame) => {
          if (
            frame.ok &&
            "output" in frame &&
            typeof frame.output === "string"
          ) {
            frames.add(decodeAnsi(frame.output).plain);
          }
        },
        (reason) => {
          ended = reason;
        },
      );
      stopFeeds.push(() => stream.close());
      return (marker: string) => {
        if (ended !== undefined)
          throw new Error(`feed ${session} ended: ${JSON.stringify(ended)}`);
        return [...frames].some((frame) => frame.includes(marker));
      };
    };
    const mainFeed = follow(primary);
    const namedFeed = follow(worktree);
    // The folder's watch has no ready signal, and a write landing before it
    // is live is never reported, so the first values are written again until
    // both feeds show them. From then on one write is heard.
    await untilHeard(
      () => {
        for (const session of [primary, worktree])
          write(session, `initial ${session}`);
      },
      () => {
        const initial = log();
        return (
          mainFeed(`initial ${primary}`) &&
          namedFeed(`initial ${worktree}`) &&
          [primary, worktree].every(
            (session) => reads(initial, session).length > 0,
          )
        );
      },
      "both feeds reading managed sources",
    );
    if (configAtRestart === "invalid") {
      const since = log().length;
      fs.writeFileSync(config(worktree), "{ invalid:");
      await until(
        () =>
          log()
            .slice(since)
            .some(
              (line) =>
                line.includes("config loaded ") &&
                fieldOf(line, "state") === "failed" &&
                fieldOf(line, "files").includes(config(worktree)),
            ),
        "the live worktree to report its invalid config",
      );
      write(worktree, "last good before restart");
      await until(
        () => namedFeed("last good before restart"),
        "the retained plugin to draw after the load error",
      );
    }
    const before = log();
    const beforeIO = readsOf(ioLog).length;
    expect(watches(before, "opened")).toHaveLength(1);
    expect(watches(before, "closed")).toHaveLength(0);
    const started = /renderer worktree\[1\] started pid=(\d+)/.exec(
      before.join("\n"),
    );
    const pid = Number(started?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === daemon.child.pid) {
      throw new Error("expected the named renderer's live child pid");
    }
    gate.hold();
    process.kill(pid, "SIGKILL");
    await until(
      () =>
        log().some((line) =>
          line.includes("renderer worktree[1] killed by SIGKILL"),
        ),
      "the host to observe the named renderer crash",
    );
    const duringRestart = () => log().slice(before.length);
    for (const session of [primary, worktree])
      write(session, `changed ${session}`);
    await until(
      () => {
        const log = duringRestart();
        return (
          mainFeed(`changed ${primary}`) &&
          reads(log, worktree).length > 0 &&
          reads(log, primary).length > 0
        );
      },
      "both managed files refreshed before the replacement boots",
      8_000,
    );
    await until(gate.held, "the replacement child to wait at the boot gate");
    const beforeBoot = duringRestart();
    expect(reads(beforeBoot, worktree)).toHaveLength(1);
    expect(reads(beforeBoot, primary)).toHaveLength(1);
    expect(
      beforeBoot.some((line) =>
        line.includes("renderer worktree[2] started"),
      ),
    ).toBe(false);
    gate.release();
    await until(
      () => namedFeed(`changed ${worktree}`),
      "the restarted renderer to push the managed value without a new request",
      8_000,
    );
    const recovered = log();
    // Both renderer processes inherit the same probe. Every physical read
    // since the crash belongs to the host and to a changed session file.
    const recoveryReads = readsOf(ioLog).slice(beforeIO);
    const hostPid = daemon.child.pid;
    expect(recoveryReads).toEqual(
      expect.arrayContaining(
        [primary, worktree].map((session) => ({
          file: sourceFile(session),
          pid: hostPid,
          operation: "readFile",
        })),
      ),
    );
    expect(recoveryReads).toHaveLength(2);
    expect(watches(recovered, "opened")).toHaveLength(1);
    expect(watches(recovered, "closed")).toHaveLength(0);

    configure(worktree, false);
    await until(
      () =>
        namedFeed(`removed ${worktree}`) &&
        declares(log().slice(recovered.length), worktree).some(
          (line) => Number(fieldOf(line, "released")) > 0,
        ),
      "the named renderer to drop its managed source",
      8_000,
    );
    const remaining = log();
    expect(watches(remaining, "closed")).toHaveLength(0);
    const beforeWrite = readsOf(ioLog).length;
    write(primary, "remaining consumer");
    await until(
      () =>
        mainFeed("remaining consumer") &&
        reads(log().slice(remaining.length), primary).length > 0,
      "the primary feed to observe a new atomic write after its sibling leaves",
      8_000,
    );
    expect(reads(log().slice(remaining.length), primary)).toHaveLength(1);

    expect(readsOf(ioLog).slice(beforeWrite)).toEqual([
      {
        file: sourceFile(primary),
        pid: daemon.child.pid,
        operation: "readFile",
      },
    ]);
    configure(primary, false);
    await until(
      () =>
        mainFeed(`removed ${primary}`) &&
        watches(log(), "closed").length >= 1,
      "the last consumer to release its one managed watch",
      8_000,
    );
    const final = log();
    expect(watches(final, "opened")).toHaveLength(1);
    expect(watches(final, "closed")).toHaveLength(1);
    // The only mutation since the crash is the intentional removal above.
    expect(declares(remaining.slice(before.length), worktree)).toHaveLength(
      1,
    );
    expect(
      reads(final.slice(before.length, remaining.length), worktree),
    ).toHaveLength(1);
  } finally {
    for (const stop of stopFeeds) stop();
    await daemon?.stop();
    await gate?.close();
    isolated.removeTmpDirs();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
