// candybar-animation-wbxz.jmm.usl, measured on a REAL daemon: a subscriber
// receives one session's frames at the rate its bar moves. While an effect
// moves the bar, the daemon draws it many times a second — faster than the one
// a second Claude Code's statusline reaches — and pushes every frame whose
// bytes moved; while nothing moves, no frame is sent that would draw the same
// bar again, and a click is pushed the moment it lands. Frames are drawn from
// the session's latest render request, so a subscriber that arrives before the
// session's first render receives the bar once that render lands.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openFrameStream } from "../src/daemon/client-frames";
import { PROTOCOL_VERSION, type Response } from "../src/daemon/protocol";
import type { StatsSnapshot } from "../src/daemon/stats";
import {
  click,
  killAndWait,
  render,
  stripAnsi,
  urlWriting,
} from "./helpers/daemon-e2e";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

// `moving` wears sparkle, the bundled loop whose bytes change most often from
// one thirtieth of a second to the next (the others were tuned to move about
// one just-noticeable step a second). `toggle` is a still bar a click changes.
const CONFIGS = {
  moving: `{ globals: { effect: "sparkle" }, segments: { a: { template: 'directory ~/code/cc-candybar' }, b: { template: 'branch main' }, c: { template: 'a moving mark' } }, root: { h: ['a', 'b', 'c'] } }`,
  still: `{ segments: { mark: { template: 'a still mark' } }, root: { h: ['mark'] } }`,
  toggle: `{ variables: { face: { kind: "state", key: "face", default: "shut" } }, actions: { flip: { set: "face", cycle: ["shut", "open"] } }, segments: { door: { template: '{{ action "flip" "door shut" "door open" }}' } }, root: { h: ['door'] } }`,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("a subscriber receives a session's frames as the bar moves", () => {
  let sockPath: string;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let daemon: RunningDaemon | undefined;

  const args = (name: keyof typeof CONFIGS): string[] => [
    "cc-candybar",
    "--config",
    path.join(projectDir, `${name}.json5`),
  ];

  // Every frame pushed for `sessionId` while `during` runs, with when each
  // arrived (ms since the subscription opened).
  async function framesOf(
    sessionId: string,
    during: () => Promise<void>,
  ): Promise<Array<{ at: number; resp: Response }>> {
    const frames: Array<{ at: number; resp: Response }> = [];
    const opened = Date.now();
    const stream = openFrameStream(
      sockPath,
      sessionId,
      (resp) => frames.push({ at: Date.now() - opened, resp }),
      (end) => {
        if (end.kind === "failed") throw end.error;
      },
    );
    await during();
    stream.close();
    return frames;
  }

  const feedStats = async (): Promise<StatsSnapshot["frameFeeds"]> => {
    const resp = await sendDaemonRequest(
      sockPath,
      { v: PROTOCOL_VERSION, kind: "stats" },
      5000,
    );
    if (!resp.ok || !("stats" in resp)) throw new Error(JSON.stringify(resp));
    return resp.stats.frameFeeds;
  };

  const outputs = (frames: Array<{ resp: Response }>): string[] =>
    frames.map(({ resp }) => {
      if (!resp.ok || !("output" in resp))
        throw new Error(`not a frame: ${JSON.stringify(resp)}`);
      return resp.output;
    });

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-feed-e2e");
    ({ sockPath, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-feed-e2e-"));
    for (const [name, text] of Object.entries(CONFIGS))
      writeFileSync(path.join(projectDir, `${name}.json5`), text);
    daemon = await spawnDaemonWithEnv(prepared.env);
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("a moving bar is drawn many times a second and pushed whenever its bytes move", async () => {
    await render(sockPath, "feed-moving", projectDir, {}, args("moving"));
    const before = await feedStats();
    const frames = await framesOf("feed-moving", () => sleep(2000));
    const after = await feedStats();
    const pushed = outputs(frames);
    for (const output of pushed)
      expect(stripAnsi(output)).toContain("a moving mark");
    // An unchanged frame is never sent twice.
    for (let i = 1; i < pushed.length; i++)
      expect(pushed[i]).not.toBe(pushed[i - 1]);
    // The daemon draws at 30 a second while the bar moves; half that leaves
    // room for a slow CI box, and is far past Claude Code's one a second.
    expect(after.drawn - before.drawn).toBeGreaterThanOrEqual(30);
    expect(after.pushed - before.pushed).toBe(pushed.length);
    expect(pushed.length).toBeGreaterThan(2);
  });

  test("a still bar is pushed once, and not again while nothing changes", async () => {
    await render(sockPath, "feed-still", projectDir, {}, args("still"));
    const frames = await framesOf("feed-still", () => sleep(1500));
    expect(outputs(frames).map(stripAnsi)).toEqual([
      expect.stringContaining("a still mark"),
    ]);
  });

  test("a click on a still bar is pushed at once, not when the next frame falls due", async () => {
    const shut = await render(
      sockPath,
      "feed-click",
      projectDir,
      {},
      args("toggle"),
    );
    const frames = await framesOf("feed-click", async () => {
      // The still bar's next frame falls due a second after the subscription
      // opened; the click lands well inside that second.
      await sleep(100);
      await click(sockPath, urlWriting(shut, "face", "open"));
      await sleep(400);
    });
    expect(outputs(frames).map(stripAnsi)).toEqual([
      expect.stringContaining("door shut"),
      expect.stringContaining("door open"),
    ]);
    expect(frames[1]!.at).toBeLessThan(800);
  });

  test("a subscriber that arrives before the session's first render receives it", async () => {
    const frames = await framesOf("feed-early", async () => {
      await sleep(200);
      await render(sockPath, "feed-early", projectDir, {}, args("still"));
      await sleep(300);
    });
    expect(outputs(frames).map(stripAnsi)).toEqual([
      expect.stringContaining("a still mark"),
    ]);
    expect(frames[0]!.at).toBeGreaterThanOrEqual(200);
  });
});
