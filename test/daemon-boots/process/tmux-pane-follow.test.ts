import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { daemonArgs } from "../../../src/daemon/acquire";
import { PROTOCOL_VERSION } from "../../../src/daemon/foundations/protocol";
import { HANDOFF_BUTTON } from "../../../src/renderer/lane-handoff";
import { textOf } from "../../../src/render/frame";
import { sendDaemonRequest } from "../../../scripts/lib/daemon/wire";
import { logLines } from "../../../scripts/lib/daemon/log";
import { until } from "../../../scripts/lib/until";
import { configFlag, frameRequest, renderBody } from "../../helpers/daemon-e2e";
import { paneSessionRecord } from "../../helpers/pane-session-record";
import { tmuxServer } from "../../helpers/private-tmux";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
} from "../../helpers/spawn-isolated-daemon";

test("the packaged pane keeps the handoff while hidden and draws the new session on return", async () => {
  const world = prepareIsolatedDaemonEnv("ccb-pane");
  const tmux = tmuxServer(world.root, { cols: 100, rows: 32 });
  const terminal = path.join(world.root, "terminal.sock");
  let daemon: Awaited<ReturnType<typeof spawnDaemonWithEnv>> | undefined;
  const { root, sockPath } = world;
  const source = { pane: tmux.pane, socket: tmux.socket, truecolor: null };
  const main = tmux
    .run("display-message", "-p", "-t", source.pane, "#{window_id}")
    .trim();
  const capture = (pane: string) => tmux.run("capture-pane", "-p", "-t", pane);
  const panes = () =>
    tmux.run("list-panes", "-t", main, "-F", "#{pane_id}").trim().split("\n");
  const request = async (sid: string, file: string, parentPid?: number) =>
    textOf(
      await frameRequest(sockPath, {
        ...renderBody(sid, root, { tmux: source }, configFlag(file)),
        claudeConfigDir: root,
        ...(parentPid === undefined ? {} : { parentPid }),
      }),
    );
  const session = async () => {
    const answer = await sendDaemonRequest(sockPath, {
      v: PROTOCOL_VERSION,
      kind: "pane-session",
      ...source,
    });
    return answer.ok && "paneSession" in answer ? answer.paneSession : null;
  };
  const when = (expected: string) => () =>
    expected + "\n" + logLines(world.env).slice(-14).join("\n");
  try {
    daemon = await spawnDaemonWithEnv(world.env, (env) => ({
      bin: process.execPath,
      args: daemonArgs(path.resolve("dist/index.mjs"), env),
    }));
    const pid = Number(
      tmux.run("display-message", "-p", "-t", source.pane, "#{pane_pid}"),
    );
    const put = paneSessionRecord(root, pid);
    const configs = ["first", "after-clear"].map((mark) => {
      const file = path.join(root, mark + ".json5");
      writeFileSync(
        file,
        JSON.stringify({
          globals: { experimentalPane: true },
          segments: { mark: { template: mark } },
          root: { h: ["mark"] },
        }),
      );
      return file;
    });
    put("first");
    execFileSync("tmux", [
      "-f",
      "/dev/null",
      "-S",
      terminal,
      "new-session",
      "-d",
      "env",
      "-u",
      "TMUX",
      "tmux",
      "-S",
      source.socket,
      "attach-session",
      "-t",
      "bar",
    ]);
    await request("first", configs[0]!);
    await until(
      () => panes().length === 2,
      when("physical split born from legacy render"),
    );
    const drawing = panes().find((id) => id !== source.pane)!;
    await until(
      () => capture(drawing).includes("first"),
      when("first packaged frame"),
    );
    expect(await request("first", configs[0]!)).toContain(HANDOFF_BUTTON);
    const away = tmux
      .run("new-window", "-PF", "#{pane_id}", "-t", "bar", "-n", "away", "cat")
      .trim();
    await until(
      () =>
        logLines(world.env).some(
          (s) =>
            s.includes("visibility socket=") &&
            s.trimEnd().endsWith("shown=" + away),
        ),
      when("only the newly selected window is visible"),
    );
    expect(await request("first", configs[0]!)).toContain(HANDOFF_BUTTON);
    await request("after-clear", configs[1]!, pid);
    await request("unrelated", configs[0]!, process.pid);
    expect(await session()).toBe("first");
    put("after-clear");
    await until(
      async () => (await session()) === "after-clear",
      when("record replacement moves ownership"),
    );
    expect(await request("after-clear", configs[1]!, pid)).toContain(
      HANDOFF_BUTTON,
    );
    expect(capture(drawing)).not.toContain("after-clear");
    tmux.run("select-window", "-t", main);
    await until(
      () => capture(drawing).includes("after-clear"),
      when("first frame on return without another render request"),
    );
    expect(panes()).toEqual(expect.arrayContaining([source.pane, drawing]));
    tmux.run("kill-pane", "-t", source.pane);
    await until(
      () =>
        !tmux
          .run("list-panes", "-a", "-F", "#{pane_id}")
          .trim()
          .split("\n")
          .includes(drawing),
      when("source close retires follower"),
    );
  } finally {
    tmux.kill();
    await daemon?.stop();
    world.removeTmpDirs();
  }
}, 45_000);
