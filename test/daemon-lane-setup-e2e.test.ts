// What a lane runs follows the session's own clicks, measured at the click,
// and the tmux status line follows a request's arrival and a click's commit:
// no draw — a request's or a frame's — starts either (src/daemon/lane-setup.ts,
// src/daemon/tmux-status.ts).

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { effectsUrl, VERB_LOAD_CONFIG, VERB_SET_STATE } from "../src/click/wire";
import { LANES, type Lane } from "../src/config/lanes";
import type { ClientHints } from "../src/daemon/protocol";
import { click, killAndWait, render } from "./helpers/daemon-e2e";
import { answeredRender, logLines, renderLines } from "./helpers/daemon-log";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { until } from "./helpers/until";

jest.setTimeout(30_000);

// Every lane off: each test's own clicks switch them.
const CONFIG = `{ segments: { mark: { template: 'a lane mark' } }, root: { h: ['mark'] } }`;

describe("lane setups and the tmux status line follow events, never a draw", () => {
  let sockPath: string;
  let removeTmpDirs: () => void;
  let env: NodeJS.ProcessEnv;
  let projectDir: string;
  let otherDir: string;
  let daemon: RunningDaemon | undefined;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-lane-e2e");
    ({ sockPath, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-lane-e2e-"));
    otherDir = path.join(projectDir, "elsewhere");
    mkdirSync(otherDir);
    writeFileSync(path.join(projectDir, "lanes.json5"), CONFIG);
    // A tmux first on the daemon's PATH whose server shows pane %7, attached
    // and active, and answers anything else with nothing to say.
    const bin = path.join(projectDir, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "tmux"),
      `#!/bin/sh\ncase "$*" in *list-panes*) printf '%%7 $1 1 1 0 1\\n' ;; *) printf '' ;; esac\n`,
    );
    chmodSync(path.join(bin, "tmux"), 0o755);
    env = { ...prepared.env, PATH: `${bin}:${prepared.env.PATH ?? ""}` };
    daemon = await spawnDaemonWithEnv(env);
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  const args = (): string[] => [
    "cc-candybar",
    "--config",
    path.join(projectDir, "lanes.json5"),
  ];
  // Each session in a tmux server of its own, so no other test's session
  // takes its pane.
  const inTmux = (sid: string): ClientHints => ({
    tmux: { socket: `/tmp/lane-e2e-${sid}`, pane: "%7", truecolor: null },
  });
  const renderIn = (sid: string, dir = projectDir): Promise<string> =>
    render(sockPath, sid, dir, inTmux(sid), args());
  const switchLanes = (sid: string, on: boolean, ...lanes: Lane[]) =>
    click(
      sockPath,
      effectsUrl(
        lanes.map((lane) => ({
          verb: VERB_SET_STATE,
          args: [sid, LANES[lane].setting, String(on)],
        })),
      ),
    );
  const laneLines = (sid: string): string[] =>
    logLines(env).filter(
      (l) => l.includes(" lane: ") && l.includes(`(session=${sid})`),
    );
  const statusLines = (sid: string, what: "holding" | "released"): string[] =>
    logLines(env).filter((l) =>
      l.includes(`tmux-status: ${what} sid=${JSON.stringify(sid)}`),
    );
  // A request whose render event is logged: everything its arrival started
  // has been logged before it. Counted by answers, since a cold render past
  // the daemon's per-request guard logs a timed-out attempt beside the one
  // its retry got.
  const renderedAgain = async (sid: string, dir = projectDir): Promise<void> => {
    const before = (await renderLines(env, sid)).filter(answeredRender).length;
    await renderIn(sid, dir);
    await renderLines(env, sid, before + 1);
  };

  test("a lane toggle with no request after it is set up once, in the turn after its click", async () => {
    const sid = "lane-click";
    await renderIn(sid);
    const events = (await renderLines(env, sid)).length;
    await switchLanes(sid, true, "tmuxStatus");
    await until(() => laneLines(sid).length > 0, "the toggle's setup");
    expect(laneLines(sid)).toEqual([
      expect.stringContaining(
        `lane: tmuxStatus on — the daemon draws %7's bar in its status line by=click (session=${sid})`,
      ),
    ]);
    // The click itself held the status line: no request came after it.
    await until(() => statusLines(sid, "holding").length > 0, "the status line's hold");
    expect(await renderLines(env, sid)).toHaveLength(events);
    // A request after it, and one from another directory, set nothing up
    // again and keep the status line held.
    await renderedAgain(sid);
    await renderedAgain(sid, otherDir);
    expect(laneLines(sid)).toHaveLength(1);
    expect(statusLines(sid, "holding")).toHaveLength(1);
    expect(statusLines(sid, "released")).toEqual([]);
  });

  test("one click of two lane toggles sets up both", async () => {
    const sid = "lane-two";
    await renderIn(sid);
    await switchLanes(sid, true, "tmuxStatus", "band");
    await until(() => laneLines(sid).length >= 2, "both toggles' setups");
    expect(laneLines(sid).map((l) => l.match(/lane: (\w+ \w+)/)![1]).sort()).toEqual([
      "band on",
      "tmuxStatus on",
    ]);
    for (const line of laneLines(sid)) expect(line).toContain(" by=click ");
  });

  test("a status line switched off is released once, and nothing re-takes it", async () => {
    const sid = "lane-off";
    await renderIn(sid);
    await switchLanes(sid, true, "tmuxStatus");
    await until(() => statusLines(sid, "holding").length > 0, "the status line's hold");
    await switchLanes(sid, false, "tmuxStatus");
    await until(() => statusLines(sid, "released").length > 0, "the status line's release");
    await renderedAgain(sid);
    expect(statusLines(sid, "holding")).toHaveLength(1);
    expect(statusLines(sid, "released")).toHaveLength(1);
  });

  // Taken by another session's request, the pane is released at the next
  // answer from its server; the click only remembers it.
  test("a click that leaves the status line's switch alone re-takes no status line released since", async () => {
    const sid = "lane-taken";
    await renderIn(sid);
    await switchLanes(sid, true, "tmuxStatus");
    await until(() => statusLines(sid, "holding").length > 0, "the status line's hold");
    await render(sockPath, "lane-taker", projectDir, inTmux(sid), args());
    await until(() => statusLines(sid, "released").length > 0, "the taken pane's release");
    expect(statusLines(sid, "released")).toEqual([
      expect.stringContaining(`pane taken by sid="lane-taker"`),
    ]);
    // The band's setup runs in the turn after its click: anything the click
    // held was logged before it.
    await switchLanes(sid, true, "band");
    await until(
      () => laneLines(sid).some((l) => l.includes("lane: band on")),
      "the band's setup",
    );
    expect(statusLines(sid, "holding")).toHaveLength(1);
  });

  test("a load-config pick of a config that switches a lane on sets it up, as the session's click", async () => {
    const sid = "lane-load";
    await renderIn(sid);
    const picked = path.join(projectDir, "tmux-on.json5");
    writeFileSync(
      picked,
      `{ globals: { experimentalTmuxStatus: true }, segments: { mark: { template: 'a lane mark' } }, root: { h: ['mark'] } }`,
    );
    await click(
      sockPath,
      `cc-candybar://${VERB_LOAD_CONFIG}/${encodeURIComponent(sid)}/${encodeURIComponent(picked)}`,
    );
    await until(() => laneLines(sid).length > 0, "the pick's setup");
    expect(laneLines(sid)).toEqual([
      expect.stringContaining(
        `lane: tmuxStatus on — the daemon draws %7's bar in its status line by=click (session=${sid})`,
      ),
    ]);
    await until(() => statusLines(sid, "holding").length > 0, "the status line's hold");
  });

  // The daemon before a restart drew the bar the toggle is clicked on: this
  // daemon holds no request of the session yet.
  test("a click before the session's first request owes its setup to that request", async () => {
    const sid = "lane-owed";
    await renderIn(sid);
    await killAndWait(daemon!, "SIGTERM");
    daemon = await spawnDaemonWithEnv(env);
    await switchLanes(sid, true, "tmuxStatus");
    await renderedAgain(sid);
    await until(() => laneLines(sid).length > 1, "the owed setup");
    // Owed at the click, which had no session to set up, and set up once, by
    // the request.
    expect(laneLines(sid)).toEqual([
      expect.stringContaining(`lane: owed tmuxStatus on (session=${sid})`),
      expect.stringContaining(" by=owed "),
    ]);
    expect(statusLines(sid, "holding")).toHaveLength(1);
  });
});
