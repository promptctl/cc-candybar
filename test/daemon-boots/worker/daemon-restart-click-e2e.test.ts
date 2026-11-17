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
import { linksOf } from "../../../src/click/read";
import { textOf, type Frame } from "../../../src/render/frame";
import { listResolvablePaletteNames } from "../../../src/themes/policy";
import type { TmuxHint } from "../../../src/tmux-hint";
import { click, clickAnswer, render, saidOf } from "../../helpers/daemon-e2e";
import { startDaemon } from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

const [PALETTE] = listResolvablePaletteNames();
const SID = "restart-click";
const READY_SCREEN = ["─".repeat(30), "❯ ", "─".repeat(30)];

const linkTo = (frame: Frame, text: string): string => {
  const hit = linksOf(frame).find((l) => l.text === text);
  if (hit === undefined)
    throw new Error(`no link "${text}" in:\n${textOf(frame)}`);
  return hit.url;
};

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

    const refused = await clickAnswer(second, linkTo(bar, "COMPACT"));
    expect(saidOf(refused)).toMatch(
      /has not been heard since the daemon started.*\(BAD_REQUEST\)$/,
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
