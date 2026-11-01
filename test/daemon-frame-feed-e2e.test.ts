// candybar-animation-wbxz.jmm.usl, measured on a daemon: a subscriber
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

import { CLICK_ERROR_HOLD_S } from "../src/daemon/click-error";
import {
  openFrameStream,
  type FrameStream,
  type StreamEnd,
} from "../src/daemon/client-frames";
import { FEED_PERIODS } from "../src/daemon/frame-feed";
import {
  followFrames,
  SWITCHED_OFF_RETRY_MS,
} from "../src/daemon/frame-follow";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  type Response,
} from "../src/daemon/protocol";
import type { StatsSnapshot } from "../src/daemon/stats";
import { click, frameRequest, sendClick, render, renderBody, renderRequest, urlWriting } from "./helpers/daemon-e2e";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import { HANDOFF_BUTTON } from "../src/daemon/lane-handoff";
import { linksOf } from "../src/click/read";
import { composeBar, textOf, type Frame } from "../src/render/frame";
import { pageOf, viewerLink } from "./helpers/diagnostics-viewer";
import { barOf } from "./helpers/drawn-frame";
import { untilHeard } from "./helpers/reload-signal";
import { writeAtomic } from "../src/utils/atomic-write";
import { until, type Condition } from "./helpers/until";
import {
  loggedLines,
  logLines,
  renderEventsOf,
  renderLines,
} from "./helpers/daemon-log";
import { POLLED } from "../src/config/settings-menu";
import {
  effectsUrl,
  VERB_LOAD_CONFIG,
  VERB_SET_STATE,
} from "../src/click/wire";
import { startDaemon, statsOf, type InWorkerDaemon } from "./helpers/in-worker-daemon";
import {
  prepareIsolatedDaemonEnv,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

// `moving` wears sparkle, the bundled loop whose bytes change most often from
// one thirtieth of a second to the next (the others were tuned to move about
// one just-noticeable step a second). `toggle` is a still bar a click changes.
// These subscribers take the band lane, whose frames are rows of runs, and a
// test of the statusline lane, whose frames are the render's own bytes, names it.
const CONFIGS = {
  moving: `{ globals: { effect: "sparkle", experimentalBand: true, experimentalStatusline: true }, segments: { a: { template: 'directory ~/code/cc-candybar' }, b: { template: 'branch main' }, c: { template: 'a moving mark' } }, root: { h: ['a', 'b', 'c'] } }`,
  // A glyph that turns every thirtieth of a second, as a lane toggle's spinner
  // does, so every frame the daemon draws while it moves is a new one.
  turning: `{ globals: { experimentalStatusline: true }, segments: { mark: { template: '{{ frames ${1 / 30} "a" ${1 / 30} "b" ${1 / 30} "c" }}' } }, root: { h: ['mark'] } }`,
  still: `{ globals: { experimentalBand: true, experimentalStatusline: true }, segments: { mark: { template: 'a still mark' } }, root: { h: ['mark'] } }`,
  // A glyph that turns once a second, the bar's only motion, as the effort
  // gauge at max does.
  beat: `{ globals: { experimentalBand: true }, segments: { mark: { template: '{{ frames 1 "tick" 1 "tock" }}' } }, root: { h: ['mark'] } }`,
  off: `{ segments: { mark: { template: 'an unswitched mark' } }, root: { h: ['mark'] } }`,
  // The band lane alone, which draws the bar elsewhere: its own file, since
  // the statusline's reset button rewrites the file it names.
  handoff: `{ globals: { experimentalBand: true }, segments: { mark: { template: 'a handed-off mark' } }, root: { h: ['mark'] } }`,
  // The same over a bar in motion.
  handoffMoving: `{ globals: { effect: "sparkle", experimentalBand: true }, segments: { mark: { template: 'a moving mark' } }, root: { h: ['mark'] } }`,
  // The band lane switched off, which a test switches on by rewriting the file
  // as another session's save would.
  fileLane: `{ segments: { mark: { template: 'a file-switched mark' } }, root: { h: ['mark'] } }`,
  // Moves, and carries a load warning (a duplicate key) the indicator
  // shows on every frame.
  warned: `{ globals: { effect: "sparkle", effect: "sparkle", experimentalBand: true, experimentalStatusline: true }, segments: { mark: { template: 'a warned mark' } }, root: { h: ['mark'] } }`,
  // Still, and its palette rule names no theme for two seconds of every four:
  // a render warning that comes and goes while nothing else moves.
  clock: `{ globals: { experimentalBand: true, palette: '{{ if or (eq (mod (int (unixEpoch now)) 4) 0) (eq (mod (int (unixEpoch now)) 4) 1) }}no-such-theme{{ else }}dracula{{ end }}' }, segments: { mark: { template: 'a clocked mark' } }, root: { h: ['mark'] } }`,
  toggle: `{ globals: { experimentalBand: true, experimentalStatusline: true }, variables: { face: { kind: "state", key: "face", default: "shut" } }, actions: { flip: { set: "face", cycle: ["shut", "open"] } }, segments: { door: { template: '{{ action "flip" "door shut" "door open" }}' } }, root: { h: ['door'] } }`,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// A pushed frame, and when it arrived: ms since framesOf first subscribed.
type Pushed = { readonly at: number; readonly resp: Response };

describe("a subscriber receives a session's frames as the bar moves", () => {
  let sockPath: string;
  let removeTmpDirs: () => void;
  let env: NodeJS.ProcessEnv;
  let projectDir: string;
  let daemon: InWorkerDaemon;

  const args = (name: keyof typeof CONFIGS): string[] => [
    "cc-candybar",
    "--config",
    path.join(projectDir, `${name}.json5`),
  ];

  // Every frame `lane` is pushed for `sessionId` while `during` runs, with when
  // each arrived. `during` is handed the frames
  // received so far, so it can wait for ones the daemon has sent before the
  // stream closes (closing drops whatever is still in flight); `elapsed`, the
  // clock those arrivals are read on; `waitFor`, the wait for them; and
  // `untilHeard`, the wait that re-applies a watched write until they come.
  // [LAW:no-silent-failure] A daemon too busy to take the subscribe inside its
  // request budget answers TIMEOUT, and the subscriber opens another, as
  // afterStreamEnd decides for every real consumer; any other end fails the
  // test, named. [LAW:no-ambient-temporal-coupling] The stream's end is part
  // of every condition `during` waits on, so its first wait after the end
  // throws it, and nothing `during` would do next runs on into the next test.
  async function framesOf(
    sessionId: string,
    during: (feed: {
      received: ReadonlyArray<Pushed>;
      elapsed: () => number;
      waitFor: typeof until;
      untilHeard: typeof untilHeard;
    }) => Promise<void>,
    lane: "band" | "statusline" = "band",
  ): Promise<Pushed[]> {
    const frames: Pushed[] = [];
    const opened = Date.now();
    const elapsed = (): number => Date.now() - opened;
    let ended: Error | null = null;
    const open = (): FrameStream =>
      openFrameStream(
        sockPath,
        sessionId,
        lane,
        (resp) => frames.push({ at: elapsed(), resp }),
        (end) => {
          if (end.kind === "refused" && end.resp.code === "TIMEOUT")
            stream = open();
          else if (end.kind !== "closed-here")
            ended = new Error(
              `the stream ended before the test closed it: ${end.kind === "failed" ? end.error.message : JSON.stringify(end)}`,
            );
        },
      );
    const live =
      (reached: Condition): Condition =>
      () => {
        if (ended !== null) throw ended;
        return reached();
      };
    const waitFor: typeof until = (reached, what, budgetMs) =>
      until(live(reached), what, budgetMs);
    const untilHeardLive: typeof untilHeard = (mutate, heard, what) =>
      untilHeard(mutate, live(heard), what);
    let stream = open();
    try {
      await during({
        received: frames,
        elapsed,
        waitFor,
        untilHeard: untilHeardLive,
      });
    } finally {
      stream.close();
    }
    if (ended !== null) throw ended;
    return frames;
  }

  const feedStats = async (): Promise<StatsSnapshot["frameFeeds"]> =>
    (await statsOf(daemon.daemon)).frameFeeds;

  // A band-lane frame's text: its rows of runs (src/daemon/lane-frames.ts).
  const barText = (resp: Response): unknown =>
    resp.ok && "band" in resp
      ? resp.band.map((row) => row.map((run) => run.text).join("")).join("\n")
      : resp;

  // What band-lane frames drew, as Frames, read as a render's answer is.
  const bars = (frames: ReadonlyArray<Pushed>): Frame[] =>
    frames.map(({ resp }) => {
      if (!resp.ok || !("band" in resp))
        throw new Error(`not a band frame: ${JSON.stringify(resp)}`);
      return barOf(
        ...resp.band.map((row) =>
          row.map(({ text, href }) => ({ text, link: href })),
        ),
      );
    });

  const shows = (frames: ReadonlyArray<Pushed>, text: string): boolean =>
    bars(frames).some((o) => textOf(o).includes(text));

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-feed-e2e");
    ({ sockPath, removeTmpDirs, env } = prepared);
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
    daemon = startDaemon({
      ...prepared.env,
      PATH: `${bin}:${prepared.env.PATH ?? ""}`,
    });
    await daemon.listen(sockPath);
  });

  afterAll(async () => {
    await daemon?.stop();
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
    const frames = await framesOf(
      "feed-moving",
      async ({ received, waitFor }) => {
        await sleep(2000);
        after = await feedStats();
        const sent = after.pushed - before.pushed;
        await waitFor(
          () => received.length >= sent,
          "every counted frame arrived",
        );
      },
    );
    const pushed = bars(frames);
    for (const bar of pushed) {
      expect(textOf(bar)).toContain("a moving mark");
      // candybar-animation-wbxz.829, .014: a frame the feed drew shows its
      // ceiling.
      expect(textOf(bar)).toMatch(/ ≤\d+ fps /u);
    }
    // An unchanged frame is never sent twice.
    for (let i = 1; i < frames.length; i++)
      expect(frames[i]!.resp).not.toEqual(frames[i - 1]!.resp);
    // The daemon draws at 30 a second while the bar moves; half that leaves
    // room for a slow CI box, and is far past Claude Code's one a second.
    expect(after.drawn - before.drawn).toBeGreaterThanOrEqual(30);
    // Every frame the daemon counted reached the subscriber; any after the
    // count are frames it pushed while the stream was still open.
    expect(pushed.length).toBeGreaterThanOrEqual(after.pushed - before.pushed);
    expect(pushed.length).toBeGreaterThan(2);
  });

  // candybar-animation-wbxz.a4h: the frames a lane is pushed are a fact of
  // every render of its session, so its toggle can show them.
  test("a render while a lane streams names that lane's subscribers and frame rate", async () => {
    await render(sockPath, "feed-rate", projectDir, {}, args("turning"));
    await framesOf(
      "feed-rate",
      async ({ received, waitFor }) => {
        await waitFor(() => received.length >= 5, "the stream is moving");
        await sleep(1000);
        await render(sockPath, "feed-rate", projectDir, {}, args("turning"));
      },
      "statusline",
    );
    const events = await renderLines(env, "feed-rate", 2);
    expect(events[0]).toContain(" feeds=- ");
    const fps = /feeds=statusline:1sub\/(\d+)fps\/shown /u.exec(events.at(-1)!);
    expect(fps).not.toBeNull();
    // 30 a second while the bar moves; a third of that leaves room for a slow
    // CI box, and is far past the one a second a polled bar reaches.
    expect(Number(fps![1])).toBeGreaterThanOrEqual(10);
  });

  test("a still bar is pushed once, and not again while nothing changes", async () => {
    const answered = await render(
      sockPath,
      "feed-still",
      projectDir,
      {},
      args("still"),
    );
    // The request's own answer is Claude Code's to poll: it shows no pace.
    expect(textOf(answered)).toMatch(
      new RegExp(`${POLLED}.*a still mark`, "su"),
    );
    let drawn = 0;
    const frames = await framesOf(
      "feed-still",
      async ({ received, waitFor }) => {
        await waitFor(() => received.length > 0, "the first frame");
        const before = (await feedStats()).drawn;
        await sleep(2000);
        drawn = (await feedStats()).drawn - before;
      },
    );
    // Its ceiling is part of the frame and does not change it.
    expect(bars(frames).map(textOf)).toEqual([
      expect.stringMatching(/ ≤30 fps .*a still mark/su),
    ]);
    // brandon-unfiled-3248.8ro6 §4e: and it is drawn once a second. A draw
    // that wrote something its view reads would wake the next frame, and the
    // still bar would be redrawn at the moving rate, its bytes never pushed.
    expect(drawn).toBeLessThanOrEqual(3);
  });

  // Lane B draws Claude Code's own statusline, so its frames are the bytes a
  // render answers, and they differ from them by the pace alone.
  test("a statusline subscriber's frame is the render's own bytes, with the feed's ceiling for its pace", async () => {
    const sid = "feed-statusline-bytes";
    const answered = await render(sockPath, sid, projectDir, {}, args("still"));
    const frames = await framesOf(
      sid,
      async ({ received, waitFor }) => {
        await waitFor(() => received.length > 0, "the first frame");
      },
      "statusline",
    );
    const paced = barOf(
      ...answered.rows.map(({ runs }) =>
        runs.flatMap((run) =>
          run.text === ` ${POLLED}`
            ? [
                { ...run, text: "≤30" },
                { ...run, text: " fps" },
              ]
            : [run],
        ),
      ),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]!.resp).toMatchObject({ output: composeBar(paced) });
  });

  // candybar-animation-wbxz.014: a bar is drawn when it next changes, so one
  // whose only motion turns once a second is drawn about once a second, each
  // frame a new one, not thirty times a second with twenty-nine dropped.
  test("a bar that turns once a second is drawn about once a second, every frame new", async () => {
    await render(sockPath, "feed-beat", projectDir, {}, args("beat"));
    let drawn = 0;
    let pushed = 0;
    const frames = await framesOf(
      "feed-beat",
      async ({ received, waitFor }) => {
        await waitFor(() => received.length > 0, "the first frame");
        const before = await feedStats();
        await sleep(3000);
        const after = await feedStats();
        drawn = after.drawn - before.drawn;
        pushed = after.pushed - before.pushed;
        await waitFor(
          () => received.length >= pushed + 1,
          "every counted frame arrived",
        );
      },
    );
    // Three turns in three seconds: a draw for each, and each pushed. A draw
    // a moment before its turn would show the last glyph again and be drawn
    // twice; the moving rate would draw about ninety.
    expect(drawn).toBeGreaterThanOrEqual(2);
    expect(drawn).toBeLessThanOrEqual(4);
    expect(pushed).toBe(drawn);
    const glyphs = bars(frames).map(
      (o) => /(tick|tock)/u.exec(textOf(o))![1],
    );
    for (let i = 1; i < glyphs.length; i++)
      expect(glyphs[i]).not.toBe(glyphs[i - 1]);
  });

  test("the viewer open over a moving bar is drawn a still period apart, not at the bar's beat", async () => {
    const sid = "feed-viewer-still";
    const bar = await render(sockPath, sid, projectDir, {}, args("warned"));
    await click(sockPath, viewerLink(bar, "open")!.url);
    let drawn = 0;
    await framesOf(sid, async ({ received, waitFor }) => {
      await waitFor(
        () => bars(received).some((o) => /\[1\/1\]/u.test(textOf(o))),
        "a frame showing the viewer",
      );
      const before = await feedStats();
      await sleep(2000);
      drawn = (await feedStats()).drawn - before.drawn;
    });
    // The viewer is still text: two still periods, not sixty moving ones.
    expect(drawn).toBeLessThanOrEqual(4);
  });

  test("a click on a still bar is pushed at once, not when the next frame falls due", async () => {
    const shut = await render(
      sockPath,
      "feed-click",
      projectDir,
      {},
      args("toggle"),
    );
    let secondAt = 0;
    const frames = await framesOf(
      "feed-click",
      async ({ received, elapsed, waitFor }) => {
        // The click lands the moment the bar's first frame is in.
        await waitFor(() => received.length > 0, "the bar before the click");
        await click(sockPath, urlWriting(shut, "face", "open"));
        await waitFor(() => received.length > 1, "the clicked bar");
        // A second click 100 ms after the first, inside the still period the
        // first one's frame started: it too is drawn within the feed's spacing,
        // not when the still bar's next frame falls due, about 900 ms after it.
        await sleep(100);
        await click(
          sockPath,
          urlWriting(bars(received)[1]!, "face", "shut"),
        );
        secondAt = elapsed();
        await waitFor(() => received.length > 2, "the bar clicked again");
      },
    );
    expect(bars(frames).map(textOf)).toEqual([
      expect.stringContaining("door shut"),
      expect.stringContaining("door open"),
      expect.stringContaining("door shut"),
    ]);
    // Measured from the click's answer, so a loop held up before it delays
    // both alike.
    expect(frames[2]!.at - secondAt).toBeLessThan(FEED_PERIODS.still / 2);
    // [LAW:no-ambient-temporal-coupling] The still bar's next frame falls due
    // a period after its first STARTED drawing, which is after the
    // subscription opened, so a frame in before a period from then can only be
    // the click's.
    expect(frames[1]!.at).toBeLessThan(FEED_PERIODS.still);
  });

  // The closing summary of `sessionId`'s feed, once the daemon has logged it.
  const closedSummary = async (sessionId: string): Promise<string> => {
    const mark = `feed sid=${JSON.stringify(sessionId)} closed `;
    const [line] = await loggedLines(
      env,
      (lines) => lines.filter((l) => l.includes(mark)),
      (found) => found.length > 0,
      "the feed's closing summary",
    );
    return line!;
  };

  // brandon-unfiled-3248.8ro6 §4e: a source's value moving between requests
  // wakes the feed (`data`), and a config saved under it wakes it
  // (`reload`). Neither waits for the still bar's next frame, a still period
  // after the last one started, nor for the session's next request.
  test("a file source rewritten between requests is pushed within the feed's spacing, woken by its data", async () => {
    const sid = "feed-source-wake";
    const statusFile = path.join(projectDir, "source-wake.txt");
    writeFileSync(statusFile, "green");
    const config = path.join(projectDir, "source-wake.json5");
    writeFileSync(
      config,
      `{ globals: { experimentalBand: true }, variables: { status: { kind: "file", path: ${JSON.stringify(statusFile)}, parse: { text: true }, cache: { watch_file: ${JSON.stringify(statusFile)} }, default: "?" } }, segments: { mark: { template: 'status {{ .status }}' } }, root: { h: ['mark'] } }`,
    );
    await render(sockPath, sid, projectDir, {}, [
      "cc-candybar",
      "--config",
      config,
    ]);
    let wrote = 0;
    const frames = await framesOf(
      sid,
      async ({ received, elapsed, waitFor, untilHeard }) => {
        await waitFor(() => received.length > 0, "the bar before the write");
        // [LAW:no-ambient-temporal-coupling] The watch has no ready signal, so
        // one value is re-applied until a frame shows it heard, and only then is
        // the measured write made, once: a retried write's frame may answer an
        // earlier round, and timed from the last it measures short.
        await untilHeard(
          () => writeAtomic(statusFile, "amber"),
          () => shows(received, "status amber"),
          "the value that proves the watch live",
        );
        wrote = elapsed();
        writeAtomic(statusFile, "red");
        await waitFor(
          () => shows(received, "status red"),
          "the rewritten value",
        );
      },
    );
    expect(bars(frames).map(textOf)).toEqual([
      expect.stringContaining("status green"),
      expect.stringContaining("status amber"),
      expect.stringContaining("status red"),
    ]);
    // Measured from the write, as the click's is: the still bar's next frame
    // falls due a still period after the last one started, just before the
    // write, so a frame in by half of one is the wake's.
    expect(frames[2]!.at - wrote).toBeLessThan(FEED_PERIODS.still / 2);
    expect(await closedSummary(sid)).toMatch(/ woke=data:[1-9]\d*,/u);
  });

  test("a config saved under an open feed is pushed with no request after it, woken by the reload", async () => {
    const sid = "feed-reload-wake";
    const config = path.join(projectDir, "reload-wake.json5");
    const configOf = (mark: string): string =>
      `{ globals: { experimentalBand: true }, segments: { mark: { template: '${mark}' } }, root: { h: ['mark'] } }`;
    writeFileSync(config, configOf("before the save"));
    await render(sockPath, sid, projectDir, {}, [
      "cc-candybar",
      "--config",
      config,
    ]);
    const frames = await framesOf(
      sid,
      async ({ received, waitFor, untilHeard }) => {
        await waitFor(() => received.length > 0, "the bar before the save");
        // The config's watch has no ready signal either, and a repeated save
        // draws the same bytes, which are never pushed twice.
        await untilHeard(
          () => writeAtomic(config, configOf("after the save")),
          () => shows(received, "after the save"),
          "the saved bar",
        );
      },
    );
    expect(bars(frames).map(textOf)).toEqual([
      expect.stringContaining("before the save"),
      expect.stringContaining("after the save"),
    ]);
    expect(await closedSummary(sid)).toMatch(/,reload:[1-9]\d*,/u);
  });

  // brandon-unfiled-3248.8ro6 §5: a frame opens no view. A load-config pick
  // moves the session's view itself, after its commit, so a feed drawing the
  // session shows the picked config with no request after the click — and
  // clearing the pick moves it back.
  test("a load-config pick under an open feed is pushed with no request after it, and the click opened the view", async () => {
    const sid = "feed-load-config";
    const picked = path.join(projectDir, "picked.json5");
    writeFileSync(
      picked,
      `{ globals: { experimentalBand: true }, segments: { mark: { template: 'the picked mark' } }, root: { h: ['mark'] } }`,
    );
    await render(sockPath, sid, projectDir, {}, args("still"));
    const pick = async (file: string): Promise<void> =>
      await click(
        sockPath,
        `cc-candybar://${VERB_LOAD_CONFIG}/${encodeURIComponent(sid)}/${encodeURIComponent(file)}`,
      );
    const frames = await framesOf(sid, async ({ received, waitFor }) => {
      await waitFor(() => received.length > 0, "the bar before the pick");
      await pick(picked);
      await waitFor(() => shows(received, "the picked mark"), "the picked bar");
      await pick("");
      await waitFor(
        () => textOf(bars(received).at(-1)!).includes("a still mark"),
        "the bar the request named, once the pick is cleared",
      );
    });
    const shown = bars(frames).map(textOf);
    expect(shown[0]).toContain("a still mark");
    expect(shown.some((text) => text.includes("the picked mark"))).toBe(true);
    // [LAW:no-ambient-temporal-coupling] The log is written off the loop, so
    // the frame a click's view-open draws can reach the test before the line
    // that records the open lands. Wait for the lines; a wait that fails
    // names the view-open lines that did land.
    const opened = await loggedLines(
      env,
      (lines) =>
        lines.filter((l) =>
          l.includes(`session view opened sid=${JSON.stringify(sid)} `),
        ),
      (found) => found.length >= 3,
      "three view-open lines for the session",
    );
    expect(opened.map((l) => / by=(\w+) /.exec(l)?.[1])).toEqual([
      "request",
      "click",
      "click",
    ]);
  });

  test("a subscriber that arrives before the session's first render receives it", async () => {
    const frames = await framesOf(
      "feed-early",
      async ({ received, waitFor }) => {
        await sleep(200);
        await render(sockPath, "feed-early", projectDir, {}, args("still"));
        await waitFor(() => received.length > 0, "the first render's frame");
      },
    );
    expect(bars(frames).map(textOf)).toEqual([
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
      openFrameStream(
        sockPath,
        "",
        "band",
        (resp) => frames.push(resp),
        resolve,
      ),
    );
    expect(end).toMatchObject({
      kind: "refused",
      resp: {
        ok: false,
        code: "BAD_REQUEST",
        error: expect.stringMatching(/sessionId/),
      },
    });
    expect(frames).toEqual([]);
  });

  // The lane toggles (candybar-animation-wbxz.81o.azo).
  const subscribeUntilEnd = (sessionId: string, lane: "band" | "pane") => {
    const frames: Response[] = [];
    let end: StreamEnd | null = null;
    const ended = new Promise<StreamEnd>((resolve) =>
      openFrameStream(
        sockPath,
        sessionId,
        lane,
        (resp) => frames.push(resp),
        (e) => resolve((end = e)),
      ),
    );
    // The frames so far, or the stream's end, thrown, once it has ended.
    const live = (): ReadonlyArray<Response> => {
      if (end !== null)
        throw new Error(`the ${lane} stream ended: ${JSON.stringify(end)}`);
      return frames;
    };
    return { frames, ended, live };
  };
  // A reader of the handoff line is told what the line is: still text, over a
  // bar that can move again once its button brings it back.
  test("the handoff line over a moving bar is a Frame that can move, and its bytes are the statusline's", async () => {
    const sid = "feed-handoff-moving";
    const body = renderBody(sid, projectDir, {}, args("handoffMoving"));
    await frameRequest(sockPath, body);
    const band = subscribeUntilEnd(sid, "band");
    await until(() => band.live().length > 0, "the band's frame");
    const output = await renderRequest(sockPath, body);
    const frame = await frameRequest(sockPath, body);
    expect(textOf(frame)).toContain(HANDOFF_BUTTON);
    expect(frame).toMatchObject({
      motion: "can-move",
      nextChange: Infinity,
      pending: [],
    });
    expect(composeBar(frame)).toBe(output);
    await click(
      sockPath,
      linksOf(frame).find((l) => l.text.includes("⟲"))!.url,
    );
    await band.ended;
  });

  // The daemon log's lines for `sid`: its render events, and how each of its
  // lane setups ended (src/daemon/lane-setup.ts).
  const renderEvents = (sid: string): string[] =>
    renderEventsOf(logLines(env), sid);
  const laneLines = (sid: string): string[] =>
    logLines(env).filter(
      (l) => l.includes(" lane: ") && l.includes(`(session=${sid})`),
    );
  const setState = async (sid: string, key: string, value: string): Promise<void> =>
    await click(
      sockPath,
      effectsUrl([{ verb: VERB_SET_STATE, args: [sid, key, value] }]),
    );

  // brandon-menus-sjhy.amf — Brandon: "When we're showing the bar in either
  // the mod or the tmux pane, we should NOT show the original bar except a
  // single line that contains a button to reset those settings".
  test("while the band draws the bar, Claude Code's statusline is one small row whose button brings the bar back", async () => {
    const sid = "feed-handoff";
    // [LAW:nothing-unseen] Each render's event says whether the statusline
    // handed off, and to which lanes.
    const events = (): string[] => renderEvents(sid);
    // The switch alone draws nothing: with no band following the session, the
    // statusline keeps the bar.
    expect(
      textOf(await render(sockPath, sid, projectDir, {}, args("handoff"))),
    ).toContain("a handed-off mark");
    await until(() => events().length > 0, "the first render's event");
    // A request answered TIMEOUT under load is asked again, and each is an
    // event: every one so far kept the bar.
    for (const event of events()) expect(event).toMatch(/ handoff=- /);
    // The band draws the whole bar.
    const band = subscribeUntilEnd(sid, "band");
    await until(() => band.live().length > 0, "the band's frame");
    expect(barText(band.frames[0]!)).toEqual(
      expect.stringContaining("a handed-off mark"),
    );
    const handedOff = await render(
      sockPath,
      sid,
      projectDir,
      {},
      args("handoff"),
    );
    expect(textOf(handedOff).trim().split("\n")).toEqual([
      `🧪 ${HANDOFF_BUTTON}`,
    ]);
    // A reader asking for the Frame is answered the line the statusline shows.
    const body = renderBody(sid, projectDir, {}, args("handoff"));
    const handoffFrame = await frameRequest(sockPath, body);
    expect(composeBar(handoffFrame)).toBe(await renderRequest(sockPath, body));
    expect(handoffFrame).toMatchObject({ nextChange: Infinity, pending: [] });
    // [LAW:no-ambient-temporal-coupling] Waited for as the fact itself, not
    // as one more event than a count read before the render: a retry of the
    // first render can land its event after that count is taken.
    await loggedLines(
      env,
      (lines) => renderEventsOf(lines, sid),
      (found) => / handoff=band /.test(found.at(-1) ?? ""),
      "the handoff render's event",
    );
    const button = linksOf(handedOff).find((l) => l.text.includes("⟲"));
    await click(sockPath, button!.url);
    // The reset took the lane's setting out of the file it was in.
    expect(
      readFileSync(path.join(projectDir, "handoff.json5"), "utf8"),
    ).not.toContain("experimentalBand");
    expect(
      textOf(await render(sockPath, sid, projectDir, {}, args("handoff"))),
    ).toContain("a handed-off mark");
    // And the band's stream is refused now its lane is off.
    expect(await band.ended).toMatchObject({ kind: "refused" });
    // The reset deleted the file's value and released no pick — the session
    // held none — and the lane's setup still followed it off (a bar pane the
    // pane lane opened closes the same way).
    await until(
      () => laneLines(sid).some((l) => l.includes("lane: band off")),
      "the lane's off setup",
    );
  });

  // What a lane runs follows the session's own clicks on its switch. Another
  // session's save to a file both read moves this session's switch too, and
  // nothing — its renders included — sets it up: setting up a lane there
  // would restart every idle Claude Code reading that file for one session's
  // save.
  test("a switch moved only by the file starts no lane setup, until the session moves it itself", async () => {
    const sid = "feed-file-lane";
    const file = path.join(projectDir, "fileLane.json5");
    await render(sockPath, sid, projectDir, { termCols: 80 }, args("fileLane"));
    // The file's watch has no ready signal, so the save is re-applied until a
    // render, each with hints its last did not report, draws by its switch.
    let cols = 80;
    await untilHeard(
      () =>
        writeAtomic(
          file,
          CONFIGS.fileLane.replace(
            "{ segments",
            "{ globals: { experimentalBand: true }, segments",
          ),
        ),
      async () => {
        await render(
          sockPath,
          sid,
          projectDir,
          { termCols: ++cols },
          args("fileLane"),
        );
        return renderEvents(sid).some((l) => l.includes(" lanes=band "));
      },
      "a render drawn by the file's switch",
    );
    await render(sockPath, sid, projectDir, { termCols: 20 }, args("fileLane"));
    // The session moves the switch itself: its click sets it up, with no
    // request after it, and it is the only setup this session's log holds.
    await setState(sid, "experimentalBand", "false");
    await until(
      () => laneLines(sid).length > 0,
      "the session's own move's setup",
    );
    expect(laneLines(sid)).toEqual([expect.stringContaining("lane: band off")]);
  });

  // The bar is handed off whole: the lane drawing it carries the indicator,
  // and so does the statusline's handoff line, whose indicator opens the same
  // viewer there. The message itself is never drawn twice.
  test("a handed-off statusline carries the bar's indicator, which opens the viewer in the statusline", async () => {
    const sid = "feed-handoff-warned";
    await render(sockPath, sid, projectDir, {}, args("warned"));
    const band = subscribeUntilEnd(sid, "band");
    await until(
      () => band.live().some((f) => String(barText(f)).includes("⚠ 1")),
      "a band frame carrying the indicator",
    );
    const handedOff = await render(
      sockPath,
      sid,
      projectDir,
      {},
      args("warned"),
    );
    expect(textOf(handedOff).trim().split("\n")).toEqual([
      `🧪 ${HANDOFF_BUTTON} ⚠ 1`,
    ]);
    expect(textOf(handedOff)).not.toContain('duplicate key "effect"');
    const last = String(barText(band.live().at(-1)!));
    expect(last).toContain("a warned mark");
    expect(last.match(/⚠/g)).toHaveLength(1);
    expect(last).not.toContain("duplicate key");
    // The statusline's indicator opens the viewer, drawn in the statusline.
    await click(sockPath, viewerLink(handedOff, "open")!.url);
    const viewer = pageOf(
      await render(sockPath, sid, projectDir, {}, args("warned")),
    );
    expect(viewer.position).toBe("1/1");
    expect(viewer.text).toContain('duplicate key "effect"');
    await click(sockPath, viewerLink(viewer.rendered, "✕")!.url);
    expect(
      textOf(await render(sockPath, sid, projectDir, {}, args("warned"))),
    ).toContain(HANDOFF_BUTTON);
  });

  // A subscribe naming no lane is a client from before the toggles, told to
  // update (VERSION_MISMATCH stops it; BAD_REQUEST would have it retry).
  test("a subscribe that names no lane, or one nobody declared, is refused", async () => {
    await render(sockPath, "feed-nolane", projectDir, {}, args("still"));
    const subscribe = (lane: unknown) =>
      sendDaemonRequest(
        sockPath,
        {
          v: PROTOCOL_VERSION,
          kind: "subscribe",
          sessionId: "feed-nolane",
          lane,
        },
        5000,
      );
    expect(await subscribe(undefined)).toMatchObject({
      ok: false,
      code: "VERSION_MISMATCH",
      daemonV: PROTOCOL_VERSION,
      error: expect.stringMatching(/names no lane .*predates the lane toggles/),
    });
    expect(await subscribe("everywhere")).toMatchObject({
      ok: false,
      code: "BAD_REQUEST",
      error: expect.stringMatching(
        /needs a lane, one of band, statusline, pane/,
      ),
    });
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
    // The menu's toggle is a session pick, honoured at the next subscribe
    // with no statusline request between.
    await setState("feed-lane", "experimentalBand", "true");
    const band = subscribeUntilEnd("feed-lane", "band");
    // Another lane of the same session is still off.
    const pane = subscribeUntilEnd("feed-lane", "pane");
    expect(await pane.ended).toMatchObject({
      kind: "refused",
      resp: {
        code: "SWITCHED_OFF",
        error: expect.stringContaining("experimentalPane"),
      },
    });
    await until(() => band.live().length > 0, "the switched-on lane's frame");
    expect(band.frames.map(barText)).toEqual([
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
      frame: (resp) => seen.push(String(barText(resp))),
      off: () => offs++,
      fault: (reason) => seen.push(`fault: ${reason}`),
      exit: (reason) => seen.push(`exit: ${reason}`),
    });
    try {
      await until(() => offs > 0, "the lane switched off", 2000);
      expect(offs).toBe(1);
      await setState("feed-follow", "experimentalBand", "true");
      await until(
        () => seen.length > 0,
        "a frame once the lane is on",
        SWITCHED_OFF_RETRY_MS + 3000,
      );
      // The first frame resumed is the bar. Later ones may follow at once —
      // the band's own setup failing here draws its refusal on the bar — so
      // the contract is the resumption, never a count of frames by a poll.
      expect(seen[0]).toEqual(expect.stringContaining("an unswitched mark"));
      expect(seen.filter((s) => /^(fault|exit): /.test(s))).toEqual([]);
    } finally {
      follower.close();
    }
  }, 20_000);

  test("a render request whose cwd is not a string is refused and counted, not thrown", async () => {
    const before = (await statsOf(daemon.daemon)).requests.errored;
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
      error: expect.stringContaining(
        "request 'cwd' is not an absolute path: 42",
      ),
    });
    expect((await statsOf(daemon.daemon)).requests.errored).toBe(before + 1);
  });

  test("a subscriber that hangs up before its subscribe is handled leaves no feed behind", async () => {
    await render(sockPath, "feed-hangup", projectDir, {}, args("still"));
    const before = await feedStats();
    await new Promise<void>((resolve) => {
      const sock = net.createConnection({ path: sockPath }, () => {
        sock.end(
          encodeFrame({
            v: PROTOCOL_VERSION,
            kind: "subscribe",
            sessionId: "feed-hangup",
            lane: "band",
          }),
        );
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

  // A render warning is known only after the walk that met it, so the frame
  // that met it is followed at once by one that counts it: an idle lane draws
  // once a second, and would otherwise show a second-old count.
  test("a warning an idle lane's frame meets is counted by a frame, with no wake of its own", async () => {
    const sid = "feed-clock-warning";
    await render(sockPath, sid, projectDir, {}, args("clock"));
    const frames = await framesOf(sid, async ({ received, waitFor }) => {
      await waitFor(
        () => received.some((f) => shows([f], "⚠ 1")),
        "a frame that counts the warning",
        8000,
      );
    });
    // The session's list is every renderer's, so the lane may count what the
    // request met from its first frame. A frame that starts counting it later
    // is the lane's next spaced frame, a still second after the one before,
    // never a wake that could feed itself.
    const shown = bars(frames).map((o) => textOf(o).includes("⚠ 1"));
    for (const [i, onset] of frames.entries()) {
      if (i === 0 || !shown[i] || shown[i - 1]) continue;
      expect(onset.at - frames[i - 1]!.at).toBeGreaterThan(500);
    }
    expect(await closedSummary(sid)).not.toMatch(/ woke=[^ ]*frame/u);
  });

  test("a frame records nothing: no session-state write", async () => {
    const sid = "feed-frame-records-nothing";
    const revision = async (): Promise<number> =>
      (await statsOf(daemon.daemon)).sessionState.revision;
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
    const shown = bars(frames).map(textOf);
    expect(shown.length).toBeGreaterThan(0);
    // Every frame counts the warned config's load warning.
    expect(shown.every((text) => text.includes("⚠ 1"))).toBe(true);
    expect(after).toBe(before);
  });

  test("a failed click's error shows on Claude Code's bar", async () => {
    const sid = "feed-click-error-bar";
    await render(sockPath, sid, projectDir, {}, args("toggle"));
    const bad = effectsUrl([{ verb: VERB_SET_STATE, args: [sid, "face", "bogus"] }]);
    // The statusline lane draws the bar where Claude Code does, so with it
    // followed a render answers the bar, where a lane that draws it elsewhere
    // would answer the handoff row.
    await framesOf(
      sid,
      async ({ received, waitFor }) => {
        await waitFor(() => received.length > 0, "the bar before the click");
        expect((await sendClick(sockPath, bad)).ok).toBe(false);
        const bar = await render(sockPath, sid, projectDir, {}, args("toggle"));
        expect(textOf(bar)).toContain("⚠ 1");
      },
      "statusline",
    );
  });

  test("a failed click's error shows on the pushed frames for the hold, and leaves by time alone", async () => {
    await render(sockPath, "feed-click-error", projectDir, {}, args("toggle"));
    const bad = effectsUrl([
      { verb: VERB_SET_STATE, args: ["feed-click-error", "face", "bogus"] },
    ]);
    // The error is the one message the bar holds, so the indicator counts it.
    const shows = (text: string): boolean => text.includes("⚠ 1");
    // The bar, the bar with the error for the hold, the bar: where the error
    // first shows, and the first frame after it that no longer does.
    const hold = (frames: ReadonlyArray<Pushed>) => {
      const shown = bars(frames).map(textOf);
      const errorAt = shown.findIndex(shows);
      const clearAt = shown.findIndex((text, i) => i > errorAt && !shows(text));
      return { shown, errorAt, clearAt };
    };
    let clickedAt = 0;
    const frames = await framesOf(
      "feed-click-error",
      async ({ received, elapsed, waitFor }) => {
        await waitFor(() => received.length > 0, "the bar before the click");
        clickedAt = elapsed();
        expect((await sendClick(sockPath, bad)).ok).toBe(false);
        await waitFor(
          () => hold(received).errorAt > 0,
          "a frame showing the error",
        );
        // No statusline request from here on: only time ends the hold, so the
        // stream stays open until a frame no longer shows it.
        // How long past the hold the clearing frame comes is the daemon's
        // scheduling, not the hold, so the wait bets nothing on it; the hold's
        // end is pinned on owned instants in test/click-error.test.ts.
        await waitFor(
          () => hold(received).clearAt > 0,
          "a frame past the hold",
          CLICK_ERROR_HOLD_S * 1000 + 10_000,
        );
      },
    );
    const { shown, errorAt, clearAt } = hold(frames);
    expect(shows(shown[0]!)).toBe(false);
    expect(errorAt).toBeGreaterThan(0);
    expect(clearAt).toBeGreaterThan(errorAt);
    // [LAW:no-ambient-temporal-coupling] Measured from the click's send, not
    // from the error frame's arrival: the daemon stamps the click after it was
    // sent, draws the clearing frame at an instant a hold past that stamp, and
    // it arrives after it is drawn — so no stall on either side can shorten it.
    expect(frames[clearAt]!.at - clickedAt).toBeGreaterThanOrEqual(
      CLICK_ERROR_HOLD_S * 1000,
    );
  });
});
