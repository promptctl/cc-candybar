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
import { PROTOCOL_VERSION, URL_FRAME_VERSION } from "../../../src/daemon/foundations/protocol";
import type { AsyncLaunchOpts } from "../../../src/proc/launcher";
import { exits } from "../../../src/proc/spawner-fake";
import { fakeLauncher, type FakeLauncher } from "../../../scripts/lib/draw-fixtures/fake-launcher";
import { systemTimekeeper } from "../../../scripts/lib/system-clock";
import { startDaemon } from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { TEST_ENV } from "../../helpers/session-environment";

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
        copyPath: { copy: "copied on desktop" },
        pinAndCopy: { do: ["pin", "copyPath"] },
      },
      segments: {
        pin: { template: '{{ action "pinAndCopy" "PIN" }}' },
        compact: { template: '{{ action "compact" "COMPACT" }}' },
        copy: { template: '{{ action "copyPath" "COPY" }}' },
      },
      root: { h: ["pin", "compact", "copy"] },
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
  let fixed!: FakeLauncher;
  const second = startDaemon(env, {
    claudeInput,
    launcher: (owner) => {
      fixed = fakeLauncher(systemTimekeeper, {
        ...owner,
        inherited: { ...owner.inherited, DESKTOP_ONLY: "restored" },
      });
      fixed.spawner.program((bin) => bin === "/usr/bin/pbcopy", exits());
      return fixed.launcher;
    },
  });
  try {
    await click(second, linkTo(bar, "COPY"));
    const copies = fixed.started().filter((start) => start.bin === "/usr/bin/pbcopy");
    expect(copies).toHaveLength(1);
    expect(copies[0]!.options.cwd).toBeUndefined();
    expect(copies[0]!.options.env?.DESKTOP_ONLY).toBe("restored");
    // The Mac that sent the first click after restart receives its copy
    // only after the session's own config edit lands.
    const verdict = await sendDaemonRequest(second, {
      kind: "url", urlV: URL_FRAME_VERSION, url: linkTo(bar, "PIN"), actsOn: "desktop",
    });
    expect(verdict).toEqual({
      ok: true, output: "", desktopActs: [{ kind: "copy", text: "copied on desktop" }],
    });
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
      ...TEST_ENV,
      SESSION_MARKER: marker,
      TMUX: paneOf(pane).socket + ",123,0",
      TMUX_PANE: pane,
    };
    const compact = {
      v: PROTOCOL_VERSION,
      kind: "render-session" as const,
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
    return frameRequest(daemon, compact);
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

const PADDING_CONFIG = JSON.stringify({
  globals: { padding: 1 },
  actions: {
    wider: { persist: "padding", min: 0, max: 6, by: 1, layer: "user" },
  },
  segments: { choice: { template: '{{ action "wider" "WIDER" }}' } },
  root: { h: ["choice"] },
});

test("after restart a superseded displayed config is stale and its current neighbor remains usable", async () => {
  const isolated = prepareIsolatedDaemonEnv("ccb-stale-display");
  const first = path.join(isolated.root, "first.json5");
  const second = path.join(isolated.root, "second.json5");
  const body = PADDING_CONFIG;
  fs.writeFileSync(first, body);
  fs.writeFileSync(second, body);
  let daemon = startDaemon(isolated.env);
  try {
    const draw = async (file: string) =>
      linkTo(
        await render(daemon, SID, isolated.root, {}, [
          "cc-candybar",
          "--config-only",
          file,
        ]),
        "WIDER",
      );
    const stale = await draw(first);
    const current = await draw(second);
    await daemon.stop();
    daemon = startDaemon(isolated.env);
    expect(await sendClick(daemon, stale)).toMatchObject({
      ok: false,
      error: expect.stringContaining("control is stale"),
    });
    expect(fs.readFileSync(first, "utf8")).toBe(body);
    expect(fs.readFileSync(second, "utf8")).toBe(body);
    await click(daemon, current);
    expect(JSON5.parse(fs.readFileSync(second, "utf8")).globals.padding).toBe(
      2,
    );
    expect(fs.readFileSync(first, "utf8")).toBe(body);
  } finally {
    await daemon.stop();
    isolated.removeTmpDirs();
  }
});

test("a held control refuses a different file discovered for the same user layer", async () => {
  const isolated = prepareIsolatedDaemonEnv("ccb-rebound-user-config");
  const folder = path.join(isolated.env.XDG_CONFIG_HOME!, "cc-candybar");
  fs.mkdirSync(folder, { recursive: true });
  const original = path.join(folder, "config.json");
  const preferred = path.join(folder, "config.json5");
  const body = PADDING_CONFIG;
  fs.writeFileSync(original, body);
  let daemon = startDaemon(isolated.env);
  try {
    const draw = async () =>
      linkTo(await render(daemon, SID, isolated.root), "WIDER");
    const old = await draw();
    await daemon.stop();
    fs.writeFileSync(preferred, body);
    daemon = startDaemon(isolated.env);
    const current = await draw();
    expect(await sendClick(daemon, old)).toMatchObject({
      ok: false,
      error: expect.stringContaining("stale"),
    });
    expect(fs.readFileSync(preferred, "utf8")).toBe(body);
    expect(fs.readFileSync(original, "utf8")).toBe(body);
    await click(daemon, current);
    await click(daemon, current);
    expect(
      JSON5.parse(fs.readFileSync(preferred, "utf8")).globals.padding,
    ).toBe(3);
    expect(fs.readFileSync(original, "utf8")).toBe(body);
  } finally {
    await daemon.stop();
    isolated.removeTmpDirs();
  }
});

test("retargeting a displayed layer's symlink refuses a held edit before the next draw", async () => {
  const isolated = prepareIsolatedDaemonEnv("ccb-retargeted-user-config");
  const first = path.join(isolated.root, "first.json5");
  const second = path.join(isolated.root, "second.json5");
  const link = path.join(isolated.root, "current.json5");
  fs.writeFileSync(first, PADDING_CONFIG);
  fs.writeFileSync(second, PADDING_CONFIG);
  fs.symlinkSync(first, link);
  const daemon = startDaemon(isolated.env);
  try {
    const bar = await render(daemon, SID, isolated.root, {}, [
      "cc-candybar",
      "--config-only",
      link,
    ]);
    fs.unlinkSync(link);
    fs.symlinkSync(second, link);
    expect(await sendClick(daemon, linkTo(bar, "WIDER"))).toMatchObject({
      ok: false,
      error: expect.stringContaining("stale"),
    });
    expect(fs.readFileSync(first, "utf8")).toBe(PADDING_CONFIG);
    expect(fs.readFileSync(second, "utf8")).toBe(PADDING_CONFIG);
  } finally {
    await daemon.stop();
    isolated.removeTmpDirs();
  }
});
