// [LAW:verifiable-goals] A click after the daemon restarts, before its
// session's next request: the host's book kept what the session is, so a
// durable write lands in the config the session rendered from, and nothing it
// kept names a pane, so a slash is typed into no pane until the session is
// heard again. Measured on the daemon's own request handling, each click a
// link the bar drew.

import fs from "node:fs";
import JSON5 from "json5";
import os from "node:os";
import path from "node:path";

import type { ClaudeInputEdge } from "../../../src/claude-input/typing";
import type { Frame } from "../../../src/render/frame";
import { listResolvablePaletteNames } from "../../../src/themes/policy";
import type { TmuxHint } from "../../../src/tmux-hint";
import { answeredEvents, saidOf, sendClick } from "../../../scripts/lib/daemon/requests";
import { click, frameRequest, hookData, linkTo, render } from "../../helpers/daemon-e2e";
import { sendDaemonRequest } from "../../../scripts/lib/daemon/wire";
import { environmentKey } from "../../../src/daemon/foundations/session-env";
import { PROTOCOL_VERSION } from "../../../src/daemon/foundations/protocol";
import type { AsyncLaunchOpts } from "../../../src/proc/launcher";
import { fakeLauncher } from "../../../scripts/lib/draw-fixtures/fake-launcher";
import { systemTimekeeper } from "../../../scripts/lib/system-clock";
import { startDaemon } from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../../scripts/lib/daemon/isolated";

jest.setTimeout(30_000);

const [PALETTE] = listResolvablePaletteNames();
const SID = "restart-click";
const READY_SCREEN = ["─".repeat(30), "❯ ", "─".repeat(30)];

const paneOf = (pane: string): TmuxHint => ({
  socket: "/tmp/ccb-restart-click/default",
  pane,
  truecolor: null,
});

test("a click after a restart writes the session's own config, and types into no pane until the session's next request", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-restart-click");
  const project = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-restart-click-")),
  );
  const file = path.join(project, "config.json5");
  fs.writeFileSync(
    file,
    `{
      actions: {
        pin: { persist: "palette", to: "${PALETTE}" },
        compact: { slash: "/compact" },
      },
      segments: {
        pin: { template: '{{ action "pin" "PIN" }}' },
        compact: { template: '{{ action "compact" "COMPACT" }}' },
      },
      root: { h: ["pin", "compact"] },
    }`,
  );
  // The panes each typed line went to.
  const typed: string[] = [];
  const claudeInput = (): ClaudeInputEdge => ({
    read: async () => ({ inMode: false, screen: READY_SCREEN }),
    type: async (hint) => {
      typed.push(hint.pane);
      return { kind: "typed" };
    },
  });
  const args = ["cc-candybar", "--config", file];
  const first = startDaemon(env, { claudeInput });
  let bar: Frame;
  try {
    bar = await render(first, SID, project, { tmux: paneOf("%7") }, args);
    await click(first, linkTo(bar, "COMPACT"));
    expect(typed).toEqual(["%7"]);
  } finally {
    await first.stop();
  }
  const second = startDaemon(env, { claudeInput });
  try {
    await click(second, linkTo(bar, "PIN"));
    const palette = (
      JSON5.parse(fs.readFileSync(file, "utf8")) as {
        globals?: { palette?: unknown };
      }
    ).globals?.palette;
    expect(palette).toBe(PALETTE);

    const refused = await sendClick(second, linkTo(bar, "COMPACT"));
    expect(saidOf(refused)).toMatch(
      /the daemon holds no request of session .*\(BAD_REQUEST\)$/,
    );
    expect(typed).toEqual(["%7"]);

    // Its next request names the pane it is in now.
    const now = await render(
      second,
      SID,
      project,
      { tmux: paneOf("%9") },
      args,
    );
    await click(second, linkTo(now, "COMPACT"));
    expect(typed).toEqual(["%7", "%9"]);
  } finally {
    await second.stop();
    removeTmpDirs();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a click in either session uses its environment for desktop tools and both tmux calls", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-click-env");
  const project = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-click-env-project-")),
  );
  const config = path.join(project, "actions.json5");
  fs.writeFileSync(
    config,
    `{
    actions: {
      copyText: { copy: "copied text" },
      openFile: { open: "vscode://file/tmp/sample" },
      compact: { slash: "/compact" },
      sessionTools: { do: ["copyText", "openFile", "compact"] },
    },
    segments: {
      tools: { template: '{{ action "sessionTools" "TOOLS" }}' },
      desktop: { template: '{{ action "copyText" "DESKTOP" }}' },
    },
    root: { h: ["tools", "desktop"] },
  }`,
  );
  const launches: AsyncLaunchOpts[] = [];
  const daemon = startDaemon(env, {
    launcher: (owner) => {
      const { launcher } = fakeLauncher(systemTimekeeper, owner);
      return {
        ...launcher,
        launch: async (options) => {
          const category = options.category;
          if (
            category === "click.pbcopy" ||
            category === "click.open" ||
            category === "claude-input.read" ||
            category === "claude-input.type"
          ) {
            launches.push(options);
            const stdout =
              category === "claude-input.read"
                ? ["0", ...READY_SCREEN].join("\n")
                : "";
            return { ok: true, stdout, stderr: "", exitCode: 0 };
          }
          return launcher.launch(options);
        },
      };
    },
  });
  const draw = async (session: string, pane: string, marker: string) => {
    const cwd = path.join(project, session);
    fs.mkdirSync(cwd, { recursive: true });
    const reported = {
      SESSION_MARKER: marker,
      TMUX: paneOf(pane).socket + ",123,0",
      TMUX_PANE: pane,
    };
    const compact = {
      v: PROTOCOL_VERSION,
      kind: "render-session",
      envKey: environmentKey(reported),
      hookData: hookData(session, project),
      cwd,
      args: ["cc-candybar", "--config-only", config],
      termCols: 120,
    };
    const turns = answeredEvents(daemon.log, session).length;
    await expect(
      sendDaemonRequest(daemon, { ...compact, cwd: "relative" }),
    ).resolves.toMatchObject({ ok: false, code: "BAD_REQUEST" });
    await expect(sendDaemonRequest(daemon, compact)).resolves.toEqual({
      ok: true,
      need: "environment",
    });
    expect(answeredEvents(daemon.log, session)).toHaveLength(turns);
    await frameRequest(daemon, {
      ...compact,
      kind: "render",
      env: reported,
      tmux: null,
    });
    return frameRequest(daemon, { ...compact, env: undefined });
  };
  const categories = [
    "click.pbcopy",
    "click.open",
    "claude-input.read",
    "claude-input.type",
  ];
  try {
    const first = await draw("click-a", "%7", "first");
    const second = await draw("click-b", "%8", "second");
    const checkTools = async (
      frame: Frame,
      session: string,
      marker: string,
    ) => {
      launches.length = 0;
      await click(daemon, linkTo(frame, "TOOLS"));
      expect(launches.map((launch) => launch.category)).toEqual(categories);
      for (const launch of launches) {
        expect(launch.cwd).toBe(path.join(project, session));
        expect(launch.environment).toMatchObject({
          SESSION_MARKER: marker,
          CLAUDE_CODE_SESSION_ID: session,
        });
      }
    };
    await checkTools(first, "click-a", "first");
    await checkTools(second, "click-b", "second");
    await checkTools(
      await draw("click-a", "%7", "changed"),
      "click-a",
      "changed",
    );
    await checkTools(second, "click-b", "second");
    launches.length = 0;
    await expect(
      sendDaemonRequest(daemon, { v: PROTOCOL_VERSION, kind: "stats" }),
    ).resolves.toMatchObject({
      ok: true,
      stats: { requests: { environmentMisses: 3 } },
    });
    await click(daemon, linkTo(first, "DESKTOP"));
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      category: "click.pbcopy",
      cwd: path.join(project, "click-a"),
      environment: {
        SESSION_MARKER: "changed",
        CLAUDE_CODE_SESSION_ID: "click-a",
      },
    });
  } finally {
    await daemon.stop();
    removeTmpDirs();
    fs.rmSync(project, { recursive: true, force: true });
  }
});
