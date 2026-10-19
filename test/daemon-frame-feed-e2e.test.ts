// candybar-animation-wbxz.jmm.usl, measured on a REAL daemon: a subscriber
// receives one session's frames at the rate its bar moves. While an effect
// moves the bar, the daemon draws it many times a second — faster than the one
// a second Claude Code's statusline reaches — and pushes every frame whose
// bytes moved; while nothing moves, no frame is sent that would draw the same
// bar again, and a click is pushed the moment it lands. Frames are drawn from
// the session's latest render request, so a subscriber that arrives before the
// session's first render receives the bar once that render lands. A bar
// nobody can see is drawn at the still rate however it moves, and a request
// the daemon cannot take is refused with a reply, never a thrown handler.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { openFrameStream, type StreamEnd } from "../src/daemon/client-frames";
import { followFrames, SWITCHED_OFF_RETRY_MS } from "../src/daemon/frame-follow";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  type Response,
} from "../src/daemon/protocol";
import type { StatsSnapshot } from "../src/daemon/stats";
import {
  click,
  killAndWait,
  sendClick,
  render,
  renderBody,
  stripAnsi,
  urlWriting,
} from "./helpers/daemon-e2e";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import {
  effectsUrl,
  VERB_LOAD_CONFIG,
  VERB_SET_STATE,
} from "../src/click/wire";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

// `moving` wears sparkle, the bundled loop whose bytes change most often from
// one thirtieth of a second to the next (the others were tuned to move about
// one just-noticeable step a second). `toggle` is a still bar a click changes.
// Every config but `off` switches on the band lane these subscribers name.
const CONFIGS = {
  moving: `{ globals: { effect: "sparkle", experimentalBand: true }, segments: { a: { template: 'directory ~/code/cc-candybar' }, b: { template: 'branch main' }, c: { template: 'a moving mark' } }, root: { h: ['a', 'b', 'c'] } }`,
  still: `{ globals: { experimentalBand: true }, segments: { mark: { template: 'a still mark' } }, root: { h: ['mark'] } }`,
  off: `{ segments: { mark: { template: 'an unswitched mark' } }, root: { h: ['mark'] } }`,
  // Moves, and carries a load warning (a duplicate key) the diagnostic strip
  // shows on every frame.
  warned: `{ globals: { effect: "sparkle", effect: "sparkle", experimentalBand: true }, segments: { mark: { template: 'a warned mark' } }, root: { h: ['mark'] } }`,
  toggle: `{ globals: { experimentalBand: true }, variables: { face: { kind: "state", key: "face", default: "shut" } }, actions: { flip: { set: "face", cycle: ["shut", "open"] } }, segments: { door: { template: '{{ action "flip" "door shut" "door open" }}' } }, root: { h: ['door'] } }`,
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
  // arrived (ms since the subscription opened). `during` is handed the frames
  // received so far, so it can wait for ones the daemon has sent before the
  // stream closes: closing drops whatever is still in flight.
  async function framesOf(
    sessionId: string,
    during: (received: ReadonlyArray<unknown>) => Promise<void>,
  ): Promise<Array<{ at: number; resp: Response }>> {
    const frames: Array<{ at: number; resp: Response }> = [];
    const opened = Date.now();
    const stream = openFrameStream(
      sockPath,
      sessionId,
      "band",
      (resp) => frames.push({ at: Date.now() - opened, resp }),
      (end) => {
        if (end.kind === "failed") throw end.error;
      },
    );
    await during(frames);
    stream.close();
    return frames;
  }

  const stats = async (): Promise<StatsSnapshot> => {
    const resp = await sendDaemonRequest(
      sockPath,
      { v: PROTOCOL_VERSION, kind: "stats" },
      5000,
    );
    if (!resp.ok || !("stats" in resp)) throw new Error(JSON.stringify(resp));
    return resp.stats;
  };
  const feedStats = async (): Promise<StatsSnapshot["frameFeeds"]> =>
    (await stats()).frameFeeds;

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
    // A tmux first on the daemon's PATH whose server shows no pane: pane %7's
    // session has no client attached.
    const bin = path.join(projectDir, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "tmux"),
      `#!/bin/sh\ncase "$*" in *list-panes*) printf '%%7 $1 0 1 0 1\\n' ;; *) printf 'stub\\n' ;; esac\n`,
    );
    chmodSync(path.join(bin, "tmux"), 0o755);
    daemon = await spawnDaemonWithEnv({
      ...prepared.env,
      PATH: `${bin}:${prepared.env.PATH ?? ""}`,
    });
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("a moving bar is drawn many times a second and pushed whenever its bytes move", async () => {
    await render(sockPath, "feed-moving", projectDir, {}, args("moving"));
    const before = await feedStats();
    // [LAW:no-ambient-temporal-coupling] The daemon's count is read while the
    // stream is still open, and the stream stays open until every frame that
    // count includes has arrived: comparing after close raced the frames still
    // in flight, which closing drops.
    let after = before;
    const frames = await framesOf("feed-moving", async (received) => {
      await sleep(2000);
      after = await feedStats();
      const sent = after.pushed - before.pushed;
      const deadline = Date.now() + 5000;
      while (received.length < sent && Date.now() < deadline) await sleep(20);
    });
    const pushed = outputs(frames);
    for (const output of pushed)
      expect(stripAnsi(output)).toContain("a moving mark");
    // An unchanged frame is never sent twice.
    for (let i = 1; i < pushed.length; i++)
      expect(pushed[i]).not.toBe(pushed[i - 1]);
    // The daemon draws at 30 a second while the bar moves; half that leaves
    // room for a slow CI box, and is far past Claude Code's one a second.
    expect(after.drawn - before.drawn).toBeGreaterThanOrEqual(30);
    // Every frame the daemon counted reached the subscriber; any after the
    // count are frames it pushed while the stream was still open.
    expect(pushed.length).toBeGreaterThanOrEqual(after.pushed - before.pushed);
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

  test("a moving bar in a pane nobody can see is drawn at the still rate", async () => {
    const tmux = {
      socket: path.join(projectDir, "tmux-socket"),
      pane: "%7",
      truecolor: null,
    };
    await render(sockPath, "feed-unseen", projectDir, { tmux }, args("moving"));
    let drawn = 0;
    await framesOf("feed-unseen", async () => {
      // The pane's server is asked once a second; until it answers, the pane
      // counts as shown.
      await sleep(1500);
      const before = (await feedStats()).drawn;
      await sleep(2000);
      drawn = (await feedStats()).drawn - before;
    });
    // One a second at the still rate; a bar someone could see draws thirty.
    expect(drawn).toBeGreaterThanOrEqual(1);
    expect(drawn).toBeLessThanOrEqual(4);
  });

  test("a subscribe that names no session is refused, and the stream ends on the refusal", async () => {
    const frames: Response[] = [];
    const end = await new Promise<StreamEnd>((resolve) =>
      openFrameStream(sockPath, "", "band", (resp) => frames.push(resp), resolve),
    );
    expect(end).toMatchObject({
      kind: "refused",
      resp: { ok: false, code: "BAD_REQUEST", error: expect.stringMatching(/sessionId/) },
    });
    expect(frames).toEqual([]);
  });

  // The lane toggles (candybar-animation-wbxz.81o.azo).
  const subscribeUntilEnd = (sessionId: string, lane: "band" | "pane") => {
    const frames: Response[] = [];
    const ended = new Promise<StreamEnd>((resolve) =>
      openFrameStream(sockPath, sessionId, lane, (resp) => frames.push(resp), resolve),
    );
    return { frames, ended };
  };
  const setState = (sid: string, key: string, value: string): Promise<void> =>
    click(sockPath, effectsUrl([{ verb: VERB_SET_STATE, args: [sid, key, value] }]));

  test("a subscribe that names no lane, or one nobody declared, is refused", async () => {
    await render(sockPath, "feed-nolane", projectDir, {}, args("still"));
    for (const lane of [undefined, "everywhere"]) {
      const resp = await sendDaemonRequest(
        sockPath,
        { v: PROTOCOL_VERSION, kind: "subscribe", sessionId: "feed-nolane", lane },
        5000,
      );
      expect(resp).toMatchObject({
        ok: false,
        code: "BAD_REQUEST",
        error: expect.stringMatching(/needs a lane, one of band, statusline, pane/),
      });
    }
  });

  test("a subscribe for a lane its session leaves off is refused, naming the toggle, and opens no feed", async () => {
    await render(sockPath, "feed-off", projectDir, {}, args("off"));
    const before = await feedStats();
    const { frames, ended } = subscribeUntilEnd("feed-off", "band");
    expect(await ended).toMatchObject({
      kind: "refused",
      resp: {
        ok: false,
        code: "SWITCHED_OFF",
        error: expect.stringContaining("globals.experimentalBand"),
      },
    });
    expect(frames).toEqual([]);
    expect(await feedStats()).toMatchObject({
      feeds: before.feeds,
      subscribers: before.subscribers,
      refused: before.refused + 1,
    });
  });

  test("a lane the session switches on streams, and switching it off ends the stream", async () => {
    await render(sockPath, "feed-lane", projectDir, {}, args("off"));
    // The menu's toggle is a session pick; the next statusline request draws
    // the bar with it.
    await setState("feed-lane", "experimentalBand", "true");
    await render(sockPath, "feed-lane", projectDir, {}, args("off"));
    const band = subscribeUntilEnd("feed-lane", "band");
    // Another lane of the same session is still off.
    const pane = subscribeUntilEnd("feed-lane", "pane");
    expect(await pane.ended).toMatchObject({
      kind: "refused",
      resp: { code: "SWITCHED_OFF", error: expect.stringContaining("experimentalPane") },
    });
    await sleep(300);
    expect(band.frames.map((r) => (r.ok && "output" in r ? stripAnsi(r.output) : r))).toEqual([
      expect.stringContaining("an unswitched mark"),
    ]);
    // Switching it off wakes the feed, whose next frame ends the stream.
    await setState("feed-lane", "experimentalBand", "false");
    expect(await band.ended).toMatchObject({
      kind: "refused",
      resp: { code: "SWITCHED_OFF" },
    });
  });

  test("a follower waits out a lane switched off and resumes the frames once it is on", async () => {
    await render(sockPath, "feed-follow", projectDir, {}, args("off"));
    const seen: string[] = [];
    let offs = 0;
    const follower = followFrames(sockPath, "feed-follow", "band", {
      frame: (resp) => seen.push(resp.ok && "output" in resp ? stripAnsi(resp.output) : JSON.stringify(resp)),
      off: () => offs++,
      fault: (reason) => seen.push(`fault: ${reason}`),
      exit: (reason) => seen.push(`exit: ${reason}`),
    });
    try {
      const deadline = (ms: number) => Date.now() + ms;
      let until = deadline(2000);
      while (offs === 0 && Date.now() < until) await sleep(20);
      expect(offs).toBe(1);
      await setState("feed-follow", "experimentalBand", "true");
      await render(sockPath, "feed-follow", projectDir, {}, args("off"));
      until = deadline(SWITCHED_OFF_RETRY_MS + 3000);
      while (seen.length === 0 && Date.now() < until) await sleep(50);
      expect(seen).toEqual([expect.stringContaining("an unswitched mark")]);
    } finally {
      follower.close();
    }
  }, 20_000);

  test("a render request whose cwd is not a string is refused and counted, not thrown", async () => {
    const before = (await stats()).requests.errored;
    const resp = await sendDaemonRequest(
      sockPath,
      {
        v: PROTOCOL_VERSION,
        kind: "render",
        ...renderBody("feed-bad-cwd", projectDir),
        cwd: 42,
      },
      5000,
    );
    expect(resp).toMatchObject({
      ok: false,
      code: "BAD_REQUEST",
      error: expect.stringContaining("request 'cwd' is not an absolute path: 42"),
    });
    expect((await stats()).requests.errored).toBe(before + 1);
  });

  test("a subscriber that hangs up before its subscribe is handled leaves no feed behind", async () => {
    await render(sockPath, "feed-hangup", projectDir, {}, args("still"));
    const before = await feedStats();
    await new Promise<void>((resolve) => {
      const sock = net.createConnection({ path: sockPath }, () => {
        sock.end(encodeFrame({ v: PROTOCOL_VERSION, kind: "subscribe", sessionId: "feed-hangup", lane: "band" }));
        sock.destroy();
        resolve();
      });
    });
    await sleep(300);
    expect(await feedStats()).toMatchObject({
      feeds: before.feeds,
      subscribers: before.subscribers,
    });
  });

  test("a frame records nothing: no session-state write and no dump write, which the session's next request makes", async () => {
    const sid = "feed-frame-records-nothing";
    const dumpFile = path.join(
      path.dirname(sockPath),
      "diagnostics",
      `${sid}.txt`,
    );
    const revision = async (): Promise<number> =>
      (await stats()).sessionState.revision;
    await render(sockPath, sid, projectDir, {}, args("still"));
    // The pick lands before anyone subscribes, so no frame draws until the
    // revision is read: every frame after it draws the warned config.
    await click(
      sockPath,
      `cc-candybar://${VERB_LOAD_CONFIG}/${encodeURIComponent(sid)}/${encodeURIComponent(path.join(projectDir, "warned.json5"))}`,
    );
    const before = await revision();
    const drawnBefore = (await feedStats()).drawn;
    let after = before;
    const frames = await framesOf(sid, async () => {
      await sleep(1500);
      // Read while the stream is open, so every frame drawn is counted.
      after = await revision();
    });
    expect((await feedStats()).drawn - drawnBefore).toBeGreaterThan(0);
    const shown = outputs(frames).map(stripAnsi);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((text) => /duplicate key/.test(text))).toBe(true);
    expect(after).toBe(before);
    expect(existsSync(dumpFile)).toBe(false);
    // The session's next request is where both are written.
    await render(sockPath, sid, projectDir, {}, args("still"));
    expect(readFileSync(dumpFile, "utf8")).toMatch(/duplicate key/);
  });

  test("a failed click's error stays on the pushed frames until a statusline request after the hold releases it", async () => {
    await render(sockPath, "feed-click-error", projectDir, {}, args("toggle"));
    const bad = effectsUrl([
      { verb: VERB_SET_STATE, args: ["feed-click-error", "face", "bogus"] },
    ]);
    const outputs: string[] = [];
    let first = "";
    let second = "";
    const frames = await framesOf("feed-click-error", async () => {
      await sleep(100);
      expect((await sendClick(sockPath, bad)).ok).toBe(false);
      await sleep(1200);
      first = await render(sockPath, "feed-click-error", projectDir, {}, args("toggle"));
      second = await render(sockPath, "feed-click-error", projectDir, {}, args("toggle"));
      await sleep(100);
    });
    for (const { resp } of frames)
      if (resp.ok && "output" in resp) outputs.push(stripAnsi(resp.output));
    const shows = (text: string): boolean => /bogus/.test(text);
    // Claude Code's own bar shows it once, and its next render is clear.
    expect(shows(stripAnsi(first))).toBe(true);
    expect(shows(stripAnsi(second))).toBe(false);
    // The frames: the bar, the bar with the error for over a second, the bar.
    const errorAt = frames.findIndex(({ resp }) => resp.ok && "output" in resp && shows(stripAnsi(resp.output)));
    const clearAt = frames.findIndex((f, i) => i > errorAt && f.resp.ok && "output" in f.resp && !shows(stripAnsi(f.resp.output)));
    expect(errorAt).toBeGreaterThan(0);
    expect(clearAt).toBeGreaterThan(errorAt);
    expect(frames[clearAt]!.at - frames[errorAt]!.at).toBeGreaterThanOrEqual(1000);
    expect(shows(outputs[0]!)).toBe(false);
  });
});
