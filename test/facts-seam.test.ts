// [LAW:verifiable-goals] The test that defines the facts seam
// (docs/design/gather-and-renderer.md §1): a renderer given a recorded facts
// stream and no owners draws the bars the live renderer drew, with zero
// filesystem reads and zero spawned processes after its load. And the
// recording that proves it is the one a person makes for a bug report: a
// session's stream written out of the daemon's render cache by its recorder
// (src/daemon/session-recorder.ts), read back by the one parser, replayed by
// the demo (src/demo/play.ts).
//
// The live half is the daemon's parts in this worker (test/helpers/
// daemon-parts.ts), settling each request as the daemon's request path does
// (`settleRequest`), because the boot ratchet admits no new booting case
// (.claude/memory/testing.md). Each
// live frame is drawn only once every fact has landed, so a line stamped
// after a draw never exists: the recording at an instant is what the frame at
// that instant drew from. Every frame, live and replayed, is drawn by the
// demo's one draw.

import { originAt } from "./helpers/render-origin";
import { dialerFake } from "../src/dial/dialer-fake";
import { systemFilesystem } from "../src/disk/system-filesystem";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NO_FILE_EVENTS } from "../src/daemon/cache/file-events";
import { RenderCache, type SessionView } from "../src/daemon/cache/render";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import {
  recordingFacts,
  type Facts,
} from "../src/daemon/facts-source";
import { homeOf } from "../src/daemon/home";
import { locations, stateDir } from "../src/daemon/paths";
import { createPayloadProviders } from "../src/daemon/payload-providers";
import {
  PROTOCOL_VERSION,
  TOTAL_BUDGET_MS,
  type ReaderRenderRequest,
} from "../src/daemon/protocol";
import { sessionIdOf, type SessionId } from "../src/daemon/session-id";
import {
  recordedCache,
  RecordingFailed,
  recordToFile,
  settleRequest,
  type RecordingSink,
  type SessionRecorder,
} from "../src/daemon/session-recorder";
import {
  sessionSource,
  type SessionSource,
} from "../src/daemon/session-source";
import { SessionState, SINGLE_RUN } from "../src/daemon/session-state";
import {
  observable,
  runInAction,
  type IObservableValue,
} from "mobx";
import {
  DIAGNOSTICS_VIEWING,
  SETTINGS_ANCHOR,
  SETTINGS_OPEN,
} from "../src/config/door";
import { drawView } from "../src/daemon/draw-view";
import { diagnosticsProjection } from "../src/render/diagnostics";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import { flashBegins, MENU_TIMEOUT_DEFAULT } from "../src/config/menu-timeout";
import { SETTINGS } from "../src/config/setting-projections";
import {
  heldArrival,
  loadDemo,
  NEVER_CLICKED,
  restoreDraw,
  type Depths,
  playDemo,
  playOf,
  readRecording,
  type DemoStep,
  type RecordingPlay,
  RecordingUnreadable,
  type Arrive,
} from "../src/demo/play";
import type { RenderedLine } from "../src/dsl/node-registry";
import {
  formatLine,
  parseRecording,
  RECORDING_VERSION,
  type FactsLine,
  type Recording,
  type RecordingLine,
  type SessionRequest,
} from "../src/facts/recording";
import { restamp } from "../src/facts/fact";
import { ok } from "../src/utils/outcome";
import type { Host } from "../src/host";
import {
  exits,
  runsFor,
  shell,
  type Behaviour,
} from "../src/proc/spawner-fake";
import { SessionEffects } from "../src/render/effect";
import { type Lane } from "../src/config/lanes";
import { drawForAnswer, setUpRender } from "../src/daemon/draw-bar";
import { checkRenderRequest } from "../src/daemon/render-checkpoint";
import type { Frame } from "../src/render/frame";
import { textOf } from "../src/render/frame";
import type { Timekeeper } from "../src/time";
import { instantAt, msOf } from "../src/utils/instant";
import type { DaemonLogger } from "../src/utils/logger";
import { RefreshLedger } from "../src/utils/refresh-ledger";
import { offlinePricing } from "../src/segments/pricing";
import { fakeLauncher, turns } from "./helpers/fake-launcher";
import { bareGates } from "./helpers/gates";
import { heldClock, type HeldClock } from "./helpers/held-clock";
import { WORLD, hostOf } from "./helpers/host";
import { TEST_LINKS } from "./helpers/link-signer";
import { until } from "./helpers/until";
import { daemonParts } from "./helpers/daemon-parts";
import { CLAUDE_START, claudeHolds } from "./helpers/claude-record";
import { configFlag } from "./helpers/daemon-e2e";

jest.setTimeout(30_000);

const SID = "seam00a1-b2c3-4d5e-8f6a-7b8c9d0e1f2a";
const AT = new Date(1_700_000_000_000);
const WIDTH = 160;
const PLUGIN_SOURCE = "plugins.p.status";

// A config placing every built-in, and one declared plugin source.
const CONFIG = `{
  plugins: ["./p/plugin.json5"],
  segments: {
    status: { template: 'status={{ .plugins.p.status.home }}' },
    home: { template: 'home={{ .home }}' },
    where: { template: 'dir={{ .current_dir }}' },
  },
  root: { h: [
    "gitaculous", "gitPr", "session", "today", "context", "metrics",
    "activity", "speed", "cacheTimer", "autocompact", "tmux", "host", "status",
    "home", "where",
  ] },
}`;
const PLUGIN = `{
  sources: { status: { scope: "session", refresh: { watch: true }, read: { file: { json: true } } } },
  segments: {},
}`;

let cleanups: Array<() => void>;
beforeEach(() => {
  cleanups = [];
});
// Every cleanup runs, so a check that fails one still tears the rig down.
afterEach(() => {
  const failed: unknown[] = [];
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch (error) {
      failed.push(error);
    }
  }
  jest.restoreAllMocks();
  if (failed.length === 1) throw failed[0];
  if (failed.length > 1) throw new AggregateError(failed, `${failed.length} cleanups failed`);
});

// A client that waits for its recording to the end.
const stays = (): AbortSignal => new AbortController().signal;

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The session's directory: a checkout whose `.git` the repo resolution reads
// and the git cache watches, the config, and the plugin with its session
// document already in managed storage.
function sessionDir(config = CONFIG): { cwd: string; configFile: string } {
  const cwd = tempDir("ccb-seam-cwd-");
  fs.mkdirSync(path.join(cwd, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(cwd, ".git", "refs", "heads", "main"), "c0ffee\n");
  fs.writeFileSync(path.join(cwd, ".git", "index"), "");
  const configFile = path.join(cwd, "config.json5");
  fs.writeFileSync(configFile, config);
  fs.mkdirSync(path.join(cwd, "p", "session"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "p", "plugin.json5"), PLUGIN);
  // The program's contract: the whole document, renamed into place.
  const tmp = path.join(cwd, "p", "session", `.${SID}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ home: "/h/seam" }));
  fs.renameSync(tmp, path.join(cwd, "p", "session", `${SID}.json`));
  return { cwd, configFile };
}

// A home holding what the live owners read of the session: Claude Code's
// settings and an empty projects tree for today's scan.
function homeDir(): { home: string; claudeConfigDir: string } {
  const home = tempDir("ccb-seam-home-");
  const claudeConfigDir = path.join(home, "claude");
  fs.mkdirSync(path.join(claudeConfigDir, "projects"), { recursive: true });
  fs.writeFileSync(
    path.join(claudeConfigDir, "settings.json"),
    JSON.stringify({ autoCompactEnabled: true }),
  );
  return { home, claudeConfigDir };
}

// What git, the forge and tmux answer the live owners, each once it has run
// `runsMs` on the clock.
function scriptPrograms(
  launcher: ReturnType<typeof fakeLauncher>,
  runsMs: number,
): void {
  const { spawner } = launcher;
  const answers = (behaviour: Behaviour): Behaviour =>
    runsFor(runsMs, behaviour);
  spawner.program(
    (bin, args) => bin === "git" && args[0] === "status",
    answers(
      exits(
        0,
        "# branch.oid c0ffee0123456789\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -0\n",
      ),
    ),
  );
  spawner.program(
    (bin, args) => bin === "git" && args[0] === "config",
    answers(exits(0, "remote.origin.url git@github.com:acme/widget.git\n")),
  );
  spawner.program(
    (bin, args) => bin === "git" && args[0] === "describe",
    answers(
      exits(128, "", "fatal: No names found, cannot describe anything.\n"),
    ),
  );
  spawner.program(
    (bin, args) => bin === "git" && args[0] === "log",
    answers(exits(0, "1700000000\n")),
  );
  spawner.program(
    (bin) => bin === "gh",
    answers(
      exits(
        0,
        JSON.stringify({
          number: 7,
          state: "OPEN",
          url: "https://github.com/acme/widget/pull/7",
          headRefOid: "c0ffee0123456789",
        }),
      ),
    ),
  );
  spawner.program((bin) => bin === "tmux", answers(exits(0, "work\n")));
}

// The pid of the stand-in Claude Code that runs the live session's client.
const CLAUDE_PID = 4242;

// The request a statusline client that Claude Code's process CLAUDE_PID ran
// sends from `cwd` with `--config <configFile>` at the epoch instant `now`, in
// its wire form, raw hints and all: what the daemon's checkpoint takes. Its
// deadline is the one a client states, its budget past the instant it sends.
function wireRequest(
  cwd: string,
  home: string,
  claudeConfigDir: string,
  configFile: string,
  now: number,
  model = "Opus 4.7",
): ReaderRenderRequest {
  return {
    v: PROTOCOL_VERSION,
    kind: "render",
    encoding: "frame",
    deadline: now + TOTAL_BUDGET_MS,
    hookData: {
      hook_event_name: "Status",
      session_id: SID,
      transcript_path: path.join(home, "transcript.jsonl"),
      cwd,
      model: { id: "claude-opus-4-7", display_name: model },
      workspace: { current_dir: cwd, project_dir: cwd },
    },
    args: configFlag(configFile),
    cwd,
    termCols: WIDTH,
    termRows: 40,
    ssh: true,
    tmux: {
      socket: path.join(home, "tmux.sock"),
      pane: "%0",
      truecolor: null,
    },
    claudeConfigDir,
    parent: { pid: CLAUDE_PID, startTime: CLAUDE_START },
  };
}

interface Rig {
  readonly cache: RenderCache<SessionSource, SessionRequest>;
  readonly recorder: SessionRecorder;
  // What the session's clicks leave, as a replay restores them: its store and
  // the histories' depths.
  readonly sessionState: SessionState;
  readonly depths: IObservableValue<Depths>;
}

// The replay's renderer: a render cache over the recording's facts arm, its
// recorder wired over it, composed as the daemon composes its own
// (src/daemon/daemon.ts). Its store holds every write, because a replay
// restores each line's picks as it reaches it and takes no turn.
function rig(
  host: Host,
  clock: Timekeeper,
  launcher: ReturnType<typeof fakeLauncher>["launcher"],
  facts: Facts,
): Rig {
  const log: DaemonLogger = () => {};
  const watchers = new WatcherRegistry({ filesystem: systemFilesystem, clock, logger: log });
  const home = homeOf(host);
  const providers = createPayloadProviders({
    clock,
    launcher,
    host,
    pricing: offlinePricing(),
    watchers,
    fileEvents: NO_FILE_EVENTS,
    logger: log,
    ledger: new RefreshLedger(log),
  });
  const sessionState = new SessionState(SINGLE_RUN);
  const depths = observable.box<Depths>(NEVER_CLICKED, { deep: false });
  const source = sessionSource({
    providers,
    sessionState,
    stateGates: bareGates().state,
    history: () => depths.get().history,
    navigation: () => depths.get().back,
  });
  const { cache, recorder } = recordedCache(
    (recording) =>
      new RenderCache<SessionSource, SessionRequest>(
        {
          clock,
          stateDir: stateDir(home),
          locations: locations(host, home),
          sessionState,
          watchers,
          storage: providers.managedStorage,
          links: TEST_LINKS,
          gates: bareGates(),
          log,
          facts,
          source,
        },
        {
          budgetBytes: () => 1024 * 1024 * 1024,
          observers: recording,
        },
      ),
    log,
  );
  cleanups.push(() => {
    recorder.close();
    cache.close();
    providers.gitProvider.close();
    providers.usageStore.close();
    providers.tmuxService.close();
    providers.hostService.close();
    providers.managedStorage.close();
    watchers.closeAll();
    sessionState.close();
  });
  return { cache, recorder, sessionState, depths };
}

// Every fact of the document answered: the owners' children run on the held
// clock's advances, `stepMs` a turn, the transcript folds on real I/O.
async function landed(
  clock: HeldClock,
  view: SessionView<SessionSource>,
  stepMs: number,
): Promise<void> {
  const pending = (): string[] => {
    const { builtins, sources, runs } = view.source.facts();
    return [
      ...Object.entries(builtins),
      ...Object.entries(sources),
      ...Object.entries(runs).map(
        ([digest, run]) => [digest, run.reading] as const,
      ),
    ]
      .filter(([, fact]) => fact.kind === "pending")
      .map(([name]) => name);
  };
  await until(
    async () => {
      clock.advance(stepMs);
      await turns();
      return pending().length === 0;
    },
    () => `every fact landed; pending: ${pending().join(", ")}`,
  );
}

// What a frame drew that it could not honour: none, in any frame here.
function warnings(): { warn: (message: string) => void; said: string[] } {
  const said: string[] = [];
  return { warn: (message) => said.push(message), said };
}

// How time passes in a request's wait: each program runs `runsMs` before it
// answers, and the wait advances the clock `stepMs` a turn. Both zero, every
// reading in a request is one instant.
interface Pace {
  readonly runsMs: number;
  readonly stepMs: number;
}
const HELD: Pace = { runsMs: 0, stepMs: 0 };

// A live session over the daemon's parts (test/helpers/daemon-parts.ts): its
// directory, its home, its held clock and scripted programs, and the frame
// feed its lanes follow through. Every frame it draws, an answer or a lane's,
// is the daemon's own draw (src/daemon/draw-bar.ts), kept in the order drawn.
// The session's histories' depths, and whether its turn's inputs can be
// read, are the case's to set; a view opened from `<home>/fails` throws as
// its source opens, standing in for any view that fails after its follow was
// taken.
function liveSession({ runsMs, stepMs }: Pace = HELD, config = CONFIG) {
  const dir = sessionDir(config);
  const { home, claudeConfigDir } = homeDir();
  claudeHolds(claudeConfigDir, CLAUDE_PID, SID);
  const clock = heldClock(AT);
  const failsFor = path.join(home, "fails");
  const lines: string[] = [];
  const depths = observable.box<Depths>(NEVER_CLICKED, { deep: false });
  const turnThrows = observable.box<string | null>(null);
  // The errors a turn's inputs threw because the case said to.
  const thrown = new Set<string>();
  // Every frame drawn, in the order drawn: each answer, and each frame a lane
  // drew between them.
  const drawn: Frame[] = [];
  const built = daemonParts({
    host: hostOf({}, { home, tmp: home }),
    clock,
    log: (level, message) => void lines.push(`${level} ${message}`),
    source: (daemon) => {
      const source = sessionSource({
        ...daemon,
        history: () => depths.get().history,
        navigation: () => {
          const reason = turnThrows.get();
          if (reason !== null) {
            thrown.add(`Error: ${reason}`);
            throw new Error(reason);
          }
          return depths.get().back;
        },
      });
      return (view) => {
        if (view.declared().facts.cwd === failsFor) {
          throw new Error(`the source of ${failsFor} throws as it opens`);
        }
        return source(view);
      };
    },
    drew: (frame) => {
      if (frame !== null) drawn.push(frame.bar);
    },
  });
  // [LAW:no-silent-failure] An error the daemon's parts only log fails the
  // case, unless it is one the case made a turn's inputs throw. Pushed ahead of
  // the teardown, so it runs after it and reads what the close logged too.
  cleanups.push(() => {
    const errors = lines.filter(
      (line) =>
        line.startsWith("error ") && ![...thrown].some((error) => line.endsWith(error)),
    );
    if (errors.length > 0) throw new Error(`the daemon logged errors:\n${errors.join("\n")}`);
  });
  cleanups.push(built.close);
  const { parts } = built;
  scriptPrograms(built.launcher, runsMs);
  const live = {
    cache: parts.renderCache,
    recorder: parts.recorder,
    menuIdle: parts.menuIdle,
    sessionState: parts.sessionState,
    // A write to the session's store, in a turn of its own, as a click's is.
    pick: (pairs: { key: string; value: string }[]): void =>
      parts.verbCtx.journalTurns.take("pick", () =>
        parts.sessionState.setBatch(SID, pairs),
      ),
    depths,
    turnThrows,
  };
  const feed = parts.frameFeeds;
  // A subscriber to `lane` of the session's frames, which draws each one it is
  // sent; returns its leave.
  const follow = (lane: Lane): (() => void) =>
    feed.subscribe(SID, {
      lane,
      frame: () => {},
      refused: (resp) => {
        throw new Error(`the ${lane} lane was refused: ${JSON.stringify(resp)}`);
      },
      drawing: () => true,
    });
  // One request of the session's from `cwd`, at the clock's instant, as the
  // daemon's request path takes one: the view declared with it, the request
  // noted and its view settled. Its answer, once every fact landed, is the
  // daemon's draw of the view it holds, noted for its recordings, and the
  // hold released.
  const arrive = (
    cwd: string,
    configFile: string,
    burnMs = 0,
    model?: string,
  ) => {
    const at = instantAt(clock);
    // What the request path spends between reading the request's instant and
    // declaring its view: what that declaration stamps is later than `at`.
    clock.burn(burnMs);
    // The request crosses the daemon's checkpoint, which stamps its pane from
    // the record that says Claude Code's process runs the session, and its view
    // is declared by the daemon's own render setup over what that passes on.
    // Its deadline bounds only the request path's wait, which this case makes
    // its own.
    const checked = checkRenderRequest(
      wireRequest(cwd, home, claudeConfigDir, configFile, clock.now(), model),
      parts.stats,
      parts.log,
      parts.home,
      parts.storedRoot,
      parts.heldSession,
    );
    if (!checked.ok) {
      throw new Error(`the checkpoint refused the request: ${checked.problems.join("; ")}`);
    }
    expect(checked.req.pane).toMatchObject({ kind: "runs", claude: { pid: CLAUDE_PID } });
    const setup = setUpRender(parts, checked.req, at, []);
    const settling = settleRequest(live.recorder, setup.view, at);
    return {
      view: setup.view,
      answer: async (): Promise<Frame> => {
        using _setup = setup;
        await landed(clock, setup.view, stepMs);
        await settling.landed;
        const frame = drawForAnswer(parts, setup, settling.arrival).drawn.body;
        drawn.push(frame);
        return frame;
      },
    };
  };
  const requestFrom = async (
    cwd: string,
    configFile: string,
    burnMs = 0,
    model?: string,
  ): Promise<Frame> => arrive(cwd, configFile, burnMs, model).answer();
  const after = async (ms: number): Promise<void> => {
    clock.advance(ms);
    await turns();
  };
  return {
    ...dir,
    home,
    clock,
    launcher: built.launcher.spawner,
    live,
    drawn,
    follow,
    arrive,
    requestFrom,
    after,
  };
}

// Whether any of `frames` shows the door's `⚠`: what a draw could not honour.
const warned = (frames: readonly Frame[]): boolean =>
  frames.some((frame) => textOf(frame).includes("⚠"));

// Every read call of fs and fs/promises, with no allow-list: a read inside a
// draw is a failure whoever makes it.
function spyReads(): () => string[] {
  const SYNC_READS = [
    "readFile",
    "readFileSync",
    "readdir",
    "readdirSync",
    "stat",
    "statSync",
    "lstat",
    "lstatSync",
    "open",
    "openSync",
    "createReadStream",
  ] as const;
  const PROMISE_READS = [
    "readFile",
    "readdir",
    "stat",
    "lstat",
    "open",
  ] as const;
  const spies = [
    ...SYNC_READS.map((name) => jest.spyOn(fs, name).mockName(`fs.${name}`)),
    ...PROMISE_READS.map((name) =>
      jest.spyOn(fsp, name).mockName(`fs/promises.${name}`),
    ),
  ];
  return () =>
    spies.flatMap((spy) =>
      spy.mock.calls.map((call) => `${spy.getMockName()}(${String(call[0])})`),
    );
}

// The demo's replay of a recording file under a held clock at its first
// request, on a machine whose home is not the recorded one and from a
// directory that is not the session's, its config loaded before the
// instruments and its frames drawn with every read and spawn counted.
async function replayFile(
  file: string,
  configFile: string,
  arriveOn: (clock: HeldClock) => Arrive = heldArrival,
  stepsOf: (play: RecordingPlay) => readonly DemoStep[] = (play) => play.steps,
): Promise<{
  frames: Frame[];
  reads: string[];
  started: readonly unknown[];
  said: string[];
}> {
  const recording = readRecording(file);
  const facts = recordingFacts({
    session: recording.session,
    opening: recording.opening.document,
    lines: recording.lines,
  });
  const play = playOf(recording, facts);
  const { startMs, opening } = play;
  const steps = stepsOf(play);
  const clock = heldClock(new Date(startMs));
  const launcher = fakeLauncher(clock);
  const replayHome = tempDir("ccb-seam-replay-");
  const host = hostOf({}, { home: replayHome, tmp: replayHome });
  const drawn = warnings();
  const log: DaemonLogger = (level, message) =>
    drawn.warn(`${level} ${message}`);
  // The load: the config and the plugin are read here, before the instruments.
  using loaded = loadDemo({
    world: {
      host,
      home: homeOf(host),
      launcher: launcher.launcher,
      clock,
      dialer: dialerFake(clock),
      parent: WORLD.parent,
      filesystem: systemFilesystem,
    },
    stateDir: stateDir(homeOf(host)),
    links: TEST_LINKS,
    configPath: configFile,
    cwd: replayHome,
    warn: drawn.warn,
  });
  const reads = spyReads();
  const frames: Frame[] = [];
  await playDemo({
    loaded,
    facts,
    // Whose home `~` names: the recorded session's, as the demo's arm reads it.
    home: recording.home,
    log,
    clock,
    opening,
    steps,
    arrive: arriveOn(clock),
    to: TEST_LINKS.to,
    frame: (frame) => frames.push(frame),
  });
  const read = reads();
  jest.restoreAllMocks();
  return { frames, reads: read, started: launcher.started(), said: drawn.said };
}

// A recording's documents in the order written: the turn's it opens on, then
// each document line's and each turn line's.
function documentsOf(recording: Recording): FactsLine[] {
  return [
    recording.opening.document,
    ...recording.lines.flatMap((line) =>
      line.kind === "facts"
        ? [line]
        : line.kind === "turn"
          ? [line.document]
          : [],
    ),
  ];
}

// Each draw of a recording, as the instant of its request and the stamp of
// the document it is drawn from: the last one before it.
function drawnFrom(
  recording: Recording,
): { request: number; document: number }[] {
  let document = recording.opening.document.at;
  return recording.lines.flatMap((line) => {
    if (line.kind === "facts") document = line.at;
    if (line.kind === "turn") document = line.document.at;
    return line.kind === "draw" ? [{ request: line.at, document }] : [];
  });
}

test("a session recorded out of the cache replays through the demo into the bars the live renderer drew, with nothing read and nothing spawned", async () => {
  const s = liveSession();
  // The bar is up before the recording starts, as a bug report's is.
  await s.requestFrom(s.cwd, s.configFile);
  const file = path.join(tempDir("ccb-seam-out-"), "bar.jsonl");
  const recorded = recordToFile(
    s.live.recorder,
    s.clock,
    sessionIdOf(SID),
    file,
    7,
    stays(),
  );
  const liveFrames: Frame[] = [];
  for (const offset of [1000, 2000, 2000]) {
    await s.after(offset);
    liveFrames.push(await s.requestFrom(s.cwd, s.configFile));
  }
  await s.after(2000);
  const { lines, answers } = await recorded;
  expect(answers).toBe(3);
  const text = fs.readFileSync(file, "utf8");
  expect(text.split("\n").filter((l) => l !== "")).toHaveLength(lines);
  // The live bar drew real facts: the branch, its PR, the tmux session, the
  // plugin's document.
  const liveText = liveFrames.map(textOf);
  expect(liveText[0]).toContain("main");
  expect(liveText[0]).toContain("#7");
  expect(liveText[0]).toContain("tmux:work");
  expect(liveText[0]).toContain("status=/h/seam");
  // The replaying machine's home is another: the frames are drawn with this.
  expect(liveText[0]).toContain(`home=${s.home}`);
  expect(warned(liveFrames)).toBe(false);

  const replay = await replayFile(file, s.configFile);
  expect(replay.reads).toEqual([]);
  expect(replay.started).toEqual([]);
  expect(replay.said).toEqual([]);
  expect(replay.frames.map(textOf)).toEqual(liveText);
  expect(replay.frames.map((f) => f.rows)).toEqual(
    liveFrames.map((f) => f.rows),
  );
});

// A config whose bar draws a `shell` source on a period, a `file` source on
// its watch, and a `shell` source keyed on the session's model: the three
// ways a run is told to read again.
function runsConfig(dir: string, note: string, command = "seam-shell"): string {
  const file = path.join(dir, `runs-${command}.json5`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      variables: {
        seamModel: { kind: "input", path: "model.display_name" },
        shelled: { kind: "shell", command, cache: { ttl: "1h" } },
        noted: { kind: "file", path: note, cache: { watch_file: note } },
        keyed: {
          kind: "shell",
          command: "seam-keyed",
          cache: { key: "{{ .seamModel }}" },
        },
      },
      segments: {
        runs: {
          template: "shell={{ .shelled }} file={{ .noted }} keyed={{ .keyed }}",
        },
      },
      root: { h: ["runs"] },
    }),
  );
  return file;
}

// A session drawing `runsConfig`, recorded across a move of its model: three
// answers, the last after the keyed source's key moved.
async function recordedRuns(): Promise<{
  s: ReturnType<typeof liveSession>;
  note: string;
  configFile: string;
  file: string;
  liveFrames: Frame[];
}> {
  const s = liveSession();
  const note = path.join(s.cwd, "note.txt");
  fs.writeFileSync(note, "from-the-file");
  const configFile = runsConfig(s.cwd, note);
  s.launcher.program(shell("seam-shell"), exits(0, "from-the-shell"));
  s.launcher.program(shell("seam-keyed"), exits(0, "keyed-opus"));
  await s.requestFrom(s.cwd, configFile);
  const file = path.join(tempDir("ccb-seam-out-"), "runs.jsonl");
  const recorded = recordToFile(
    s.live.recorder,
    s.clock,
    sessionIdOf(SID),
    file,
    7,
    stays(),
  );
  const liveFrames: Frame[] = [];
  for (const offset of [1000, 2000]) {
    await s.after(offset);
    liveFrames.push(await s.requestFrom(s.cwd, configFile));
  }
  // The model moves, so the keyed source's key does, and its run answers anew.
  s.launcher.program(shell("seam-keyed"), exits(0, "keyed-sonnet"));
  await s.after(1000);
  liveFrames.push(await s.requestFrom(s.cwd, configFile, 0, "Sonnet 4.6"));
  // To the recording's end, seven seconds after it started.
  await s.after(3000);
  expect((await recorded).answers).toBe(3);
  return { s, note, configFile, file, liveFrames };
}

test("a session's shell and file sources, recorded live, replay with what each run read, with nothing read and nothing spawned", async () => {
  const { configFile, file, liveFrames } = await recordedRuns();
  const liveText = liveFrames.map(textOf);
  expect(liveText).toEqual([
    expect.stringContaining(
      "shell=from-the-shell file=from-the-file keyed=keyed-opus",
    ),
    expect.stringContaining(
      "shell=from-the-shell file=from-the-file keyed=keyed-opus",
    ),
    expect.stringContaining(
      "shell=from-the-shell file=from-the-file keyed=keyed-sonnet",
    ),
  ]);
  expect(warned(liveFrames)).toBe(false);
  // Each run crossed the recording in its documents.
  const recording = readRecording(file);
  expect(
    documentsOf(recording).map((line) => Object.keys(line.facts.runs).length),
  ).toContain(3);

  const replay = await replayFile(file, configFile);
  expect(replay.reads).toEqual([]);
  expect(replay.started).toEqual([]);
  expect(replay.said).toEqual([]);
  expect(replay.frames.map(textOf)).toEqual(liveText);
});

test("a session that moves to another directory replays each run from the directory its request came from", async () => {
  const s = liveSession();
  const note = path.join(s.cwd, "note.txt");
  fs.writeFileSync(note, "from-the-file");
  const configFile = runsConfig(s.cwd, note);
  s.launcher.program(shell("seam-shell"), exits(0, "from-the-shell"));
  s.launcher.program(shell("seam-keyed"), exits(0, "keyed-opus"));
  await s.requestFrom(s.cwd, configFile);
  const file = path.join(tempDir("ccb-seam-out-"), "moved.jsonl");
  const recorded = recordToFile(
    s.live.recorder,
    s.clock,
    sessionIdOf(SID),
    file,
    7,
    stays(),
  );
  // The session's next request comes from another directory: a shell run
  // there is another run, under another digest.
  const moved = sessionDir().cwd;
  const liveFrames: Frame[] = [];
  await s.after(1000);
  liveFrames.push(await s.requestFrom(s.cwd, configFile));
  await s.after(1000);
  liveFrames.push(await s.requestFrom(moved, configFile));
  await s.after(5000);
  expect((await recorded).answers).toBe(2);
  const liveText = liveFrames.map(textOf);
  expect(liveText).toEqual([
    expect.stringContaining("shell=from-the-shell"),
    expect.stringContaining("shell=from-the-shell"),
  ]);

  const replay = await replayFile(file, configFile);
  expect(replay.reads).toEqual([]);
  expect(replay.started).toEqual([]);
  expect(replay.frames.map(textOf)).toEqual(liveText);
});

test("a replay against a config whose command was edited since the recording draws that source as failed, never pending, and still spawns nothing", async () => {
  const { s, note, file } = await recordedRuns();
  const edited = runsConfig(s.cwd, note, "seam-edited");
  const replay = await replayFile(file, edited);
  expect(replay.started).toEqual([]);
  expect(replay.reads).toEqual([]);
  // The edited source's run is in no document: its variable answers its
  // failure's fallback, not a loading cell that would never land, and the
  // runs the recording holds still draw what they read. The failure's text is
  // the variable's (test/facts-source.test.ts).
  expect(replay.frames.map(textOf)).toEqual([
    expect.stringContaining("shell= file=from-the-file keyed=keyed-opus"),
    expect.stringContaining("shell= file=from-the-file keyed=keyed-opus"),
    expect.stringContaining("shell= file=from-the-file keyed=keyed-sonnet"),
  ]);
});

test("a session recorded with a pick made and a menu open replays with the pick in effect and the menu open, flashing where the live menu flashed", async () => {
  const s = liveSession();
  // Placements fade in and out, and one appears when the model moves: a
  // frame keeps the last frame's memory to fade from only while the store's
  // revision holds, so the revision a replay draws at is in its frames.
  const configFile = path.join(path.dirname(s.configFile), "fades.json5");
  fs.writeFileSync(
    configFile,
    `{
      plugins: ["./p/plugin.json5"],
      globals: { transitions: true },
      segments: {
        newer: { template: "newer", when: '{{ eq .model.display_name "Opus 5" }}' },
      },
      root: { h: ["session", "newer", "tmux"] },
    }`,
  );
  await s.requestFrom(s.cwd, configFile);
  const file = path.join(tempDir("ccb-seam-out-"), "menu.jsonl");
  const leave = new AbortController();
  const recorded = recordToFile(
    s.live.recorder,
    s.clock,
    sessionIdOf(SID),
    file,
    600,
    leave.signal,
  );
  // A click, as it leaves the session: the theme picked and not saved, the
  // settings menu open, two steps to undo, and the menus' idle clock begun.
  const click = (pairs: { key: string; value: string }[]): void => {
    s.live.pick(pairs);
    s.live.menuIdle.clicked(SID, instantAt(s.clock));
  };
  click([
    { key: SETTINGS.theme.sessionKey, value: "nord" },
    { key: SETTINGS_ANCHOR, value: SETTINGS_OPEN },
  ]);
  runInAction(() =>
    s.live.depths.set({ history: { undo: 2, redo: 0, sinceEdit: 0 }, back: 0 }),
  );
  const liveFrames: Frame[] = [];
  await s.after(1000);
  liveFrames.push(await s.requestFrom(s.cwd, configFile));
  // The menu closed and opened again between two draws: the same values, at
  // a revision the frame's memory drops at, so the placement the new model
  // shows appears at once rather than fading in.
  click([{ key: SETTINGS_ANCHOR, value: DISCLOSURE_CLOSED }]);
  click([{ key: SETTINGS_ANCHOR, value: SETTINGS_OPEN }]);
  await s.after(1000);
  liveFrames.push(await s.requestFrom(s.cwd, configFile, 0, "Opus 5"));
  // Inside the closing flash's first lit hold, before the menu times out.
  const timeoutS = MENU_TIMEOUT_DEFAULT;
  await s.after((flashBegins(timeoutS) - 1 + 0.2) * 1000);
  liveFrames.push(await s.requestFrom(s.cwd, configFile, 0, "Opus 5"));
  leave.abort();
  const { answers } = await recorded;
  expect(answers).toBe(3);

  // The live bar had the menu open in every frame, its undo control, and the
  // flash lit on its menu rows in the last frame only.
  const menuRows = (frame: Frame) =>
    frame.rows.filter((row) => row.kind === "menu");
  for (const frame of liveFrames) expect(menuRows(frame)).not.toEqual([]);
  expect(textOf(liveFrames[0]!)).toContain("↶");
  expect(menuRows(liveFrames[2]!)).not.toEqual(menuRows(liveFrames[1]!));
  expect(textOf(liveFrames[0]!)).not.toContain("newer");
  expect(textOf(liveFrames[1]!)).toContain("newer");
  // The draws read one set of values at two revisions.
  const states = readRecording(file).lines.flatMap((line) =>
    line.kind === "draw" ? [line.state] : [],
  );
  expect(states[1]!.values).toEqual(states[0]!.values);
  expect(states[1]!.revision).not.toBe(states[0]!.revision);
  expect(states[0]!.values[SETTINGS.theme.sessionKey]).toBe("nord");
  expect(warned(liveFrames)).toBe(false);

  const replay = await replayFile(file, configFile);
  expect(replay.reads).toEqual([]);
  expect(replay.started).toEqual([]);
  expect(replay.said).toEqual([]);
  expect(replay.frames).toEqual(liveFrames);
});

test("a recording made on a moving clock replays each frame from what its answer drew: the lanes that landed during the request's wait", async () => {
  // Every program takes 300ms, and the wait moves the clock 50ms a turn: a
  // request's lanes land well after its instant, and before its answer.
  const s = liveSession({ runsMs: 300, stepMs: 50 });
  const other = sessionDir();
  await s.requestFrom(s.cwd, s.configFile);
  const file = path.join(tempDir("ccb-seam-out-"), "moving.jsonl");
  const recorded = recordToFile(
    s.live.recorder,
    s.clock,
    sessionIdOf(SID),
    file,
    10,
    stays(),
  );
  const liveFrames: Frame[] = [];
  // Each move opens a view whose lanes first answer inside its request's wait.
  for (const dir of [other, s, other]) {
    await s.after(1000);
    liveFrames.push(await s.requestFrom(dir.cwd, dir.configFile));
  }
  s.live.recorder.close();
  expect((await recorded).answers).toBe(3);
  // The live answers drew the landed lanes, which were stamped after their
  // request's instant.
  const liveText = liveFrames.map(textOf);
  for (const text of liveText) expect(text).toContain("#7");
  const drew = drawnFrom(readRecording(file));
  expect(drew).toHaveLength(3);
  for (const { request, document } of drew)
    expect(document).toBeGreaterThan(request);

  const replay = await replayFile(file, s.configFile);
  expect(replay.reads).toEqual([]);
  expect(replay.started).toEqual([]);
  expect(replay.frames.map(textOf)).toEqual(liveText);
  expect(replay.frames.map((f) => f.rows)).toEqual(
    liveFrames.map((f) => f.rows),
  );
});

// The play's steps with each answer drawn as the live arm draws one: at the
// instant its request arrived at, found by the request's offset, since the
// live arm learns that instant only as the request arrives.
const asLiveAnswers = ({ startMs, steps }: RecordingPlay): DemoStep[] =>
  steps.map((step) =>
    step.kind === "draw" &&
    step.handed.drawing.by === "request" &&
    "instant" in step.at
      ? { ...step, at: { request: msOf(step.at.instant) - startMs } }
      : step,
  );

test("a play draws the live arm's answer at the instant its arm says the request arrived at, not at the request's offset", async () => {
  const s = liveSession();
  await s.requestFrom(s.cwd, s.configFile);
  const file = path.join(tempDir("ccb-seam-arrive-"), "bar.jsonl");
  const recorded = recordToFile(
    s.live.recorder,
    s.clock,
    sessionIdOf(SID),
    file,
    7,
    stays(),
  );
  for (let i = 0; i < 2; i++) {
    await s.after(1000);
    await s.requestFrom(s.cwd, s.configFile);
  }
  await s.after(6000);
  await recorded;
  const clockConfig = path.join(tempDir("ccb-seam-clock-"), "config.json5");
  fs.writeFileSync(
    clockConfig,
    `{ variables: { clock: { kind: "time", layout: "05" } },
       segments: { s: { template: 's={{ .clock }}' } }, root: { h: ["s"] } }`,
  );
  // An arm whose requests each arrive 7s later than the one before, as a
  // live demo's do when each settle outlasts the frame interval: the drawn
  // clock is the arrival's, whatever the offset scheduled.
  const late = (clock: HeldClock): Arrive => {
    let lateMs = 0;
    return async (atMs) => {
      lateMs += 7000;
      clock.advance(Math.max(0, atMs + lateMs - clock.now()));
      return instantAt(clock);
    };
  };
  const recording = readRecording(file);
  const seconds = recording.lines
    .flatMap((line) => (line.kind === "request" ? [line.at] : []))
    .map(
      (at, n) =>
        `s=${String((Math.floor(at) + 7 * (n + 1)) % 60).padStart(2, "0")}`,
    );
  const replay = await replayFile(file, clockConfig, late, asLiveAnswers);
  expect(replay.said).toEqual([]);
  expect(
    replay.frames.map((frame) => /s=\d\d/.exec(textOf(frame))?.[0]),
  ).toEqual(seconds);
});

test("a request answered after another moved the session to another directory replays from the view it held: its own document and declaration", async () => {
  const s = liveSession({ runsMs: 300, stepMs: 50 });
  const other = sessionDir();
  await s.requestFrom(s.cwd, s.configFile);
  const file = path.join(tempDir("ccb-seam-out-"), "overlap.jsonl");
  const recorded = recordToFile(
    s.live.recorder,
    s.clock,
    sessionIdOf(SID),
    file,
    10,
    stays(),
  );
  await s.after(1000);
  // A's wait is open on the first view when B opens the second.
  const a = s.arrive(s.cwd, s.configFile);
  await s.after(100);
  const b = s.arrive(other.cwd, other.configFile);
  const liveFrames = [await a.answer(), await b.answer()];
  s.live.recorder.close();
  expect((await recorded).answers).toBe(2);
  const liveText = liveFrames.map(textOf);
  expect(liveText[0]).toContain(`dir=${s.cwd}`);
  expect(liveText[1]).toContain(`dir=${other.cwd}`);

  const replay = await replayFile(file, s.configFile);
  expect(replay.reads).toEqual([]);
  expect(replay.started).toEqual([]);
  expect(replay.frames.map(textOf)).toEqual(liveText);
  expect(replay.frames.map((f) => f.rows)).toEqual(
    liveFrames.map((f) => f.rows),
  );
});

test("a recording started during a request's wait holds only the requests it saw arrive, and replays into their frames", async () => {
  const s = liveSession({ runsMs: 300, stepMs: 50 });
  await s.requestFrom(s.cwd, s.configFile);
  await s.after(1000);
  const waiting = s.arrive(s.cwd, s.configFile);
  const file = path.join(tempDir("ccb-seam-out-"), "midwait.jsonl");
  const recorded = recordToFile(
    s.live.recorder,
    s.clock,
    sessionIdOf(SID),
    file,
    10,
    stays(),
  );
  await waiting.answer();
  await s.after(1000);
  const seen = await s.requestFrom(s.cwd, s.configFile);
  s.live.recorder.close();
  expect((await recorded).answers).toBe(1);
  const replay = await replayFile(file, s.configFile);
  expect(replay.frames.map(textOf)).toEqual([textOf(seen)]);
  expect(replay.frames.map((f) => f.rows)).toEqual([seen.rows]);
});

test("a document stamped in the instant of a draw, after it, reaches the next draw and not that one", async () => {
  const s = liveSession();
  await s.requestFrom(s.cwd, s.configFile);
  const written: RecordingLine[] = [];
  s.live.recorder.record(sessionIdOf(SID), {
    write: (line) => written.push(line),
    end: () => {},
  });
  // Under the held clock the request, what it stamped and its answer share
  // one instant.
  const liveFrame = await s.requestFrom(s.cwd, s.configFile);
  const request = written.find((line) => line.kind === "request");
  const last = written.findLast((line) => line.kind === "facts");
  const drew = written.find((line) => line.kind === "draw");
  if (
    request?.kind !== "request" ||
    last?.kind !== "facts" ||
    drew?.kind !== "draw"
  ) {
    throw new Error("the recording holds the request, a document and a draw");
  }
  // A document stamped after that draw, at its instant, then a second request
  // at the same instant and its answer.
  const after: RecordingLine = {
    kind: "facts",
    at: request.at,
    facts: {
      ...last.facts,
      seq: last.facts.seq + 1,
      builtins: {
        ...last.facts.builtins,
        hostName: restamp(undefined, ok("elsewhere"), request.at),
      },
    },
  };
  const file = path.join(tempDir("ccb-seam-out-"), "instant.jsonl");
  fs.writeFileSync(
    file,
    [...written, after, request, { ...drew, request: request.at }]
      .map(formatLine)
      .join(""),
  );
  const replay = await replayFile(file, s.configFile);
  expect(replay.frames.map(textOf)[0]).toEqual(textOf(liveFrame));
  expect(textOf(liveFrame)).not.toContain("elsewhere");
  expect(replay.frames.map(textOf)[1]).toContain("elsewhere");
});

test("a recording follows the session to the view a request from another directory opens, and the file still replays", async () => {
  const s = liveSession();
  const other = sessionDir();
  await s.requestFrom(s.cwd, s.configFile);
  const file = path.join(tempDir("ccb-seam-out-"), "moved.jsonl");
  const recorded = recordToFile(
    s.live.recorder,
    s.clock,
    sessionIdOf(SID),
    file,
    10,
    stays(),
  );
  await s.after(1000);
  await s.requestFrom(s.cwd, s.configFile);
  await s.after(1000);
  // The move: a new view, declared a little after the request's instant.
  await s.requestFrom(other.cwd, other.configFile, 5);
  await s.after(1000);
  await s.requestFrom(other.cwd, other.configFile);
  s.live.recorder.close();
  expect((await recorded).answers).toBe(3);
  // The recording opens on the first view's current document, and the
  // successor's opening document starts its sequence again, once.
  const seqs = documentsOf(readRecording(file)).map((line) => line.facts.seq);
  expect(seqs[0]).toBeGreaterThan(1);
  expect(seqs.filter((seq) => seq === 1)).toHaveLength(1);
  expect(seqs.indexOf(1)).toBeGreaterThan(0);
  const replay = await replayFile(file, s.configFile);
  expect(replay.frames).toHaveLength(3);
  expect(replay.reads).toEqual([]);
  expect(replay.started).toEqual([]);
});

test("a view whose open failed is never recorded, and the recording takes up the next view the session opens", async () => {
  const s = liveSession();
  await s.requestFrom(s.cwd, s.configFile);
  const written: RecordingLine[] = [];
  const ended: unknown[] = [];
  s.live.recorder.record(sessionIdOf(SID), {
    write: (line) => written.push(line),
    end: (failure) => ended.push(failure),
  });
  const before = written.length;
  // A request from the directory whose view's source throws: its follow was
  // taken and its opening document stamped, but the cache never entered it.
  const failing = path.join(s.home, "fails");
  fs.mkdirSync(failing);
  fs.writeFileSync(path.join(failing, "config.json5"), CONFIG);
  await s.after(1000);
  await expect(
    s.requestFrom(failing, path.join(failing, "config.json5")),
  ).rejects.toThrow(/throws as it opens/);
  // Nothing: no document of the view that never opened, and no request,
  // since the request never reached a view to settle.
  expect(written.slice(before)).toEqual([]);
  expect(s.live.cache.sessionView(SID)).toBeNull();
  await s.after(1000);
  await s.requestFrom(s.cwd, s.configFile);
  // The next view's opening turn, then its request and what landed.
  const reopened = written.slice(before);
  expect(reopened[0]).toMatchObject({
    kind: "turn",
    held: false,
    document: { facts: { seq: 1 } },
  });
  expect(reopened.filter((line) => line.kind === "request")).toHaveLength(1);
  expect(ended).toEqual([]);
});

test("a recording the daemon's close ends is whole: its counts are the file's, and it parses", async () => {
  const s = liveSession();
  await s.requestFrom(s.cwd, s.configFile);
  const file = path.join(tempDir("ccb-seam-out-"), "closed.jsonl");
  const recorded = recordToFile(
    s.live.recorder,
    s.clock,
    sessionIdOf(SID),
    file,
    60,
    stays(),
  );
  await s.after(1000);
  await s.requestFrom(s.cwd, s.configFile);
  s.live.recorder.close();
  const { lines, answers, daemonClosed } = await recorded;
  const text = fs.readFileSync(file, "utf8");
  expect(text.split("\n").filter((l) => l !== "")).toHaveLength(lines);
  expect(answers).toBe(1);
  expect(daemonClosed).toBe(true);
  expect(drawnFrom(parseRecording(text))).toHaveLength(1);
  // The file is the owner's alone: it holds the session's paths and usage.
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  // A record request handled after the close is refused for the close.
  expect(() =>
    s.live.recorder.record(sessionIdOf(SID), {
      write: () => {},
      end: () => {},
    }),
  ).toThrow(/^the daemon is closing/);
});

test("a recording no request was answered in leaves no file, so the same path records again", async () => {
  const s = liveSession();
  await s.requestFrom(s.cwd, s.configFile);
  const file = path.join(tempDir("ccb-seam-out-"), "idle.jsonl");
  const idle = recordToFile(
    s.live.recorder,
    s.clock,
    sessionIdOf(SID),
    file,
    1,
    stays(),
  );
  await s.after(1000);
  expect(await idle).toMatchObject({
    path: file,
    answers: 0,
    daemonClosed: false,
  });
  expect(fs.existsSync(file)).toBe(false);
});

test("a recording a write ended before any request leaves no file either", async () => {
  const s = liveSession();
  const file = path.join(tempDir("ccb-seam-out-"), "failed.jsonl");
  const failing = {
    record: (session: SessionId, sink: RecordingSink) => {
      sink.write({ kind: "recording", session, home: s.home });
      sink.end({ kind: "failed", error: new Error("EIO") });
      return () => {};
    },
  };
  await expect(
    recordToFile(failing, s.clock, sessionIdOf(SID), file, 1, stays()),
  ).rejects.toThrow(RecordingFailed);
  expect(fs.existsSync(file)).toBe(false);
});

test("a recording whose client leaves ends there, whole, and writes nothing after", async () => {
  const s = liveSession();
  await s.requestFrom(s.cwd, s.configFile);
  const file = path.join(tempDir("ccb-seam-out-"), "left.jsonl");
  const client = new AbortController();
  const recorded = recordToFile(
    s.live.recorder,
    s.clock,
    sessionIdOf(SID),
    file,
    60,
    client.signal,
  );
  await s.after(1000);
  await s.requestFrom(s.cwd, s.configFile);
  client.abort();
  const { lines, answers } = await recorded;
  await s.after(1000);
  await s.requestFrom(s.cwd, s.configFile);
  const text = fs.readFileSync(file, "utf8");
  expect(text.split("\n").filter((l) => l !== "")).toHaveLength(lines);
  expect(answers).toBe(1);
  expect(drawnFrom(parseRecording(text))).toHaveLength(1);
});

test("a recording is refused for a session with no view, and onto a file that exists, leaving the file as it was", async () => {
  const s = liveSession();
  await s.requestFrom(s.cwd, s.configFile);
  const out = tempDir("ccb-seam-out-");
  const nobody = path.join(out, "nobody.jsonl");
  expect(() =>
    s.live.recorder.record(sessionIdOf("nobody"), {
      write: () => {},
      end: () => {},
    }),
  ).toThrow(/no view of session "nobody" is open in this daemon/);
  await expect(
    recordToFile(
      s.live.recorder,
      s.clock,
      sessionIdOf("nobody"),
      nobody,
      1,
      stays(),
    ),
  ).rejects.toThrow(/no view of session "nobody"/);
  expect(fs.existsSync(nobody)).toBe(false);
  const kept = path.join(out, "kept.jsonl");
  fs.writeFileSync(kept, "keep\n");
  await expect(
    recordToFile(s.live.recorder, s.clock, sessionIdOf(SID), kept, 1, stays()),
  ).rejects.toThrow(`${kept} already exists`);
  expect(fs.readFileSync(kept, "utf8")).toBe("keep\n");
});

test("a recording of another format is refused by the demo naming the file", () => {
  const file = path.join(tempDir("ccb-seam-out-"), "v-next.jsonl");
  fs.writeFileSync(
    file,
    `${JSON.stringify({ kind: "recording", v: RECORDING_VERSION + 1, session: SID })}\n`,
  );
  expect(() => readRecording(file)).toThrow(RecordingUnreadable);
  expect(() => readRecording(file)).toThrow(
    `${file} is a v${RECORDING_VERSION + 1} recording; this build reads v${RECORDING_VERSION}`,
  );
});

test("a recording of a session's facts replays through a second cache into the bars the live renderer drew", async () => {
  const s = liveSession();
  await s.requestFrom(s.cwd, s.configFile);
  const written: RecordingLine[] = [];
  s.live.recorder.record(sessionIdOf(SID), {
    write: (line) => written.push(line),
    end: () => {},
  });
  const liveFrames: Frame[] = [];
  for (let i = 0; i < 4; i++) {
    await s.after(2000);
    liveFrames.push(await s.requestFrom(s.cwd, s.configFile));
  }
  // The recording crosses the text: the lines as the recorder writes them,
  // read back by the one parser, so the format is part of what is proved.
  const recording = parseRecording(written.map(formatLine).join(""));
  // The clock starts at the first request, the view at the opening turn.
  const first = recording.lines.find((line) => line.kind === "request");
  if (first === undefined) throw new Error("the recording holds no request");
  const replayTmp = tempDir("ccb-seam-replay-");
  const replayClock = heldClock(new Date(first.at * 1000));
  const replayLauncher = fakeLauncher(replayClock);
  const arm = recordingFacts({
    session: recording.session,
    opening: recording.opening.document,
    lines: recording.lines,
  });
  // A renderer whose home is the recorded one, as a replay is handed it.
  const replay = rig(
    hostOf({}, { home: recording.home, tmp: replayTmp }),
    replayClock,
    replayLauncher.launcher,
    arm,
  );
  // The load: the config and the plugin are read here, before the instruments.
  replay.cache.getOrCreate(originAt(s.cwd, s.configFile));
  const reads = spyReads();
  const effects = new SessionEffects<RenderedLine>(SID);
  const drawn = warnings();
  const replayFrames: Frame[] = [];
  // The lines in the file's order, each request's view held until the next.
  restoreDraw(replay.sessionState, replay.depths, SID, recording.opening.state);
  let held = replay.cache.holdSession(
    originAt(s.cwd, s.configFile),
    recording.opening.request,
  );
  let elapsed = 0;
  for (const line of recording.lines) {
    if (line.kind === "facts") {
      arm.reach(line);
    } else if (line.kind === "turn") {
      // No turn is held in this case: a turn line is taken, never held.
      restoreDraw(replay.sessionState, replay.depths, SID, line.state);
      arm.reach(line.document);
      held.view.requested(line.request);
    } else if (line.kind === "request") {
      const offset = Math.round((line.at - first.at) * 1000);
      replayClock.advance(offset - elapsed);
      elapsed = offset;
      held[Symbol.dispose]();
      held = replay.cache.holdSession(originAt(s.cwd, s.configFile), line.request);
      await settleRequest(replay.recorder, held.view, line.at).landed;
    } else if (line.kind === "declared") {
      held.view.requested(line.request);
    } else if (line.kind === "state") {
      restoreDraw(replay.sessionState, replay.depths, SID, line.state);
    } else {
      restoreDraw(replay.sessionState, replay.depths, SID, line.state);
      replayFrames.push(
        drawView(
          held.view,
          line,
          line.at,
          effects,
          line.state.idleSince,
          replay.sessionState.get(SID, DIAGNOSTICS_VIEWING),
          TEST_LINKS.to,
          ({ message }) => drawn.warn(message),
        ).body,
      );
    }
  }
  held[Symbol.dispose]();
  expect(reads()).toEqual([]);
  expect(replayLauncher.started()).toEqual([]);
  expect(drawn.said).toEqual([]);
  expect(replayFrames.map(textOf)).toEqual(liveFrames.map(textOf));
  expect(replayFrames.map((f) => f.rows)).toEqual(
    liveFrames.map((f) => f.rows),
  );
  expect(PLUGIN_SOURCE in recording.opening.document.facts.sources).toBe(true);
});

// A turn whose inputs cannot be read holds the bar on the last turn taken: its
// request and its picks, which the session has since moved past, with the
// failure as the `⚠` beside the settings door. The live side is the daemon's
// own draw, so the list the recording carries is the one the daemon built.
const HELD_REASON = "the back history is unreadable";
const held = (s: ReturnType<typeof liveSession>, reason: string | null) =>
  runInAction(() => s.live.turnThrows.set(reason));
const pick = (
  s: ReturnType<typeof liveSession>,
  pairs: { key: string; value: string }[],
) => s.live.pick(pairs);

// What a replay of a held turn says it did: each hold is the recording's.
const heldSays = (said: readonly string[]) =>
  said.every((line) =>
    line.includes("the recorded session's turn was held here"),
  );

// The session's config with the model it was drawn for placed, so a frame
// says which request its turn was composed from.
function modelConfig(s: ReturnType<typeof liveSession>): string {
  const file = path.join(path.dirname(s.configFile), "model.json5");
  fs.writeFileSync(
    file,
    CONFIG.replace(
      "segments: {",
      "segments: {\n    model: { template: 'model={{ .model.display_name }}' },",
    ).replace("root: { h: [", 'root: { h: [\n    "model",'),
  );
  return file;
}

async function recordHeld(
  s: ReturnType<typeof liveSession>,
  name: string,
  during: (file: string) => Promise<Frame[]>,
): Promise<{ file: string; liveFrames: Frame[] }> {
  const file = path.join(tempDir("ccb-seam-out-"), name);
  const leave = new AbortController();
  const recorded = recordToFile(
    s.live.recorder,
    s.clock,
    sessionIdOf(SID),
    file,
    600,
    leave.signal,
  );
  const liveFrames = await during(file);
  leave.abort();
  const { answers } = await recorded;
  expect(answers).toBe(liveFrames.length);
  return { file, liveFrames };
}

async function expectReplayed(
  file: string,
  configFile: string,
  liveFrames: Frame[],
): Promise<void> {
  const replay = await replayFile(file, configFile);
  expect(replay.reads).toEqual([]);
  expect(replay.started).toEqual([]);
  expect(heldSays(replay.said)).toBe(true);
  expect(replay.frames.map(textOf)).toEqual(liveFrames.map(textOf));
  expect(replay.frames.map((f) => f.rows)).toEqual(
    liveFrames.map((f) => f.rows),
  );
}

test("a session recorded across a turn that could not be taken replays the daemon's frames: the held turn's request and picks, and its ⚠", async () => {
  const s = liveSession();
  const configFile = modelConfig(s);
  await s.requestFrom(s.cwd, configFile);
  const { file, liveFrames } = await recordHeld(s, "held.jsonl", async () => {
    const frames: Frame[] = [];
    await s.after(1000);
    frames.push(await s.requestFrom(s.cwd, configFile));
    // The turn's inputs stop reading, and a pick lands while they do.
    held(s, HELD_REASON);
    pick(s, [{ key: SETTINGS.theme.sessionKey, value: "nord" }]);
    await s.after(1000);
    frames.push(await s.requestFrom(s.cwd, configFile, 0, "Opus 5"));
    held(s, null);
    await s.after(1000);
    frames.push(await s.requestFrom(s.cwd, configFile, 0, "Opus 5"));
    return frames;
  });
  const [before, during, after] = liveFrames.map(textOf);
  // Held: the older request and the failure shown.
  expect(during).toContain("model=Opus 4.7");
  expect(during).toContain("⚠ 1");
  // Released: the newest request and the pick, and nothing to show.
  expect(after).toContain("model=Opus 5");
  expect(after).not.toContain("⚠");
  expect(before).not.toContain("⚠");
  // The pick moved the bar's colours only once the turn was taken again.
  expect(liveFrames[2]!.rows).not.toEqual(liveFrames[1]!.rows);
  await expectReplayed(file, configFile, liveFrames);
});

test("a session recorded from inside a held turn opens on the held turn, and replays the daemon's frames", async () => {
  const s = liveSession();
  const configFile = modelConfig(s);
  await s.requestFrom(s.cwd, configFile);
  // The ⚠ is up before the recording starts, as a bug report's is.
  held(s, HELD_REASON);
  pick(s, [{ key: SETTINGS.theme.sessionKey, value: "nord" }]);
  const { file, liveFrames } = await recordHeld(s, "inside.jsonl", async () => {
    const frames: Frame[] = [];
    await s.after(1000);
    frames.push(await s.requestFrom(s.cwd, configFile, 0, "Opus 5"));
    held(s, null);
    await s.after(1000);
    frames.push(await s.requestFrom(s.cwd, configFile, 0, "Opus 5"));
    return frames;
  });
  const [during, after] = liveFrames.map(textOf);
  expect(during).toContain("model=Opus 4.7");
  expect(during).toContain("⚠ 1");
  expect(after).toContain("model=Opus 5");
  expect(after).not.toContain("⚠");
  expect(readRecording(file).opening.held).toBe(true);
  await expectReplayed(file, configFile, liveFrames);
});

test("a click between draws, before the turn is held, replays in the held frames: the picks and depths the held turn was taken over", async () => {
  const s = liveSession();
  await s.requestFrom(s.cwd, s.configFile);
  const { file, liveFrames } = await recordHeld(s, "click.jsonl", async () => {
    const frames: Frame[] = [];
    await s.after(1000);
    frames.push(await s.requestFrom(s.cwd, s.configFile));
    // A click with no request after it: the theme picked, the settings menu
    // open, two steps to undo. The live turn is taken over it.
    pick(s, [
      { key: SETTINGS.theme.sessionKey, value: "nord" },
      { key: SETTINGS_ANCHOR, value: SETTINGS_OPEN },
    ]);
    runInAction(() =>
      s.live.depths.set({
        history: { undo: 2, redo: 0, sinceEdit: 0 },
        back: 0,
      }),
    );
    held(s, HELD_REASON);
    await s.after(1000);
    frames.push(await s.requestFrom(s.cwd, s.configFile, 0, "Opus 5"));
    held(s, null);
    await s.after(1000);
    frames.push(await s.requestFrom(s.cwd, s.configFile, 0, "Opus 5"));
    return frames;
  });
  const during = liveFrames[1]!;
  // Held on the turn the click made: the menu open with its undo control,
  // the older request, and the failure shown.
  expect(during.rows.filter((row) => row.kind === "menu")).not.toEqual([]);
  expect(textOf(during)).toContain("↶");
  expect(textOf(during)).toContain("⚠ 1");
  await expectReplayed(file, s.configFile, liveFrames);
});

test("a request answered from a held view the session moved away from replays that view's held turn, and the current view's after it", async () => {
  const s = liveSession({ runsMs: 300, stepMs: 50 });
  const other = sessionDir();
  await s.requestFrom(s.cwd, s.configFile);
  const { file, liveFrames } = await recordHeld(s, "moved-held.jsonl", async () => {
    await s.after(1000);
    // A's wait is open on the first view when B opens the second.
    const a = s.arrive(s.cwd, s.configFile);
    await s.after(100);
    const b = s.arrive(other.cwd, other.configFile);
    // Both views' facts land, then their turns stop reading before either
    // answer is drawn, and a pick lands.
    await landed(s.clock, a.view, 50);
    await landed(s.clock, b.view, 50);
    held(s, HELD_REASON);
    pick(s, [{ key: SETTINGS.theme.sessionKey, value: "nord" }]);
    const frames = [await a.answer(), await b.answer()];
    held(s, null);
    return frames;
  });
  const liveText = liveFrames.map(textOf);
  expect(liveText[0]).toContain(`dir=${s.cwd}`);
  expect(liveText[1]).toContain(`dir=${other.cwd}`);
  // The first view's hold crosses as its own turn, not the current view's.
  const heldAt = readRecording(file).lines.flatMap((line) =>
    line.kind === "turn" && line.held ? [line.request.cwd] : [],
  );
  expect(heldAt).toContain(s.cwd);
  await expectReplayed(file, s.configFile, liveFrames);
});

test("a click on a state variable a source is keyed on, before the recording starts, replays from the run the live session held", async () => {
  const s = liveSession();
  const configFile = path.join(s.cwd, "detail.json5");
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      variables: {
        detail: { kind: "state", key: "seam.detail", default: "off" },
        detailed: {
          kind: "shell",
          command: "seam-detail",
          cache: { key: "{{ .detail }}" },
        },
      },
      segments: {
        runs: { template: "detail={{ .detail }} run={{ .detailed }}" },
      },
      root: { h: ["runs"] },
    }),
  );
  s.launcher.program(shell("seam-detail"), exits(0, "ran"));
  await s.requestFrom(s.cwd, configFile);
  // A click with no request after it: the key moves, and its run lands.
  pick(s, [{ key: "seam.detail", value: "on" }]);
  await s.after(1000);
  const { file, liveFrames } = await recordHeld(s, "detail.jsonl", async () => {
    await s.after(1000);
    return [await s.requestFrom(s.cwd, configFile)];
  });
  expect(textOf(liveFrames[0]!)).toContain("detail=on run=ran");
  const replay = await replayFile(file, configFile);
  expect(replay.reads).toEqual([]);
  expect(replay.started).toEqual([]);
  expect(replay.said).toEqual([]);
  expect(replay.frames.map(textOf)).toEqual(liveFrames.map(textOf));
});

test("a click that moves a source's state key mid-recording replays the old run's value until the new run lands, as the live bar drew it", async () => {
  const s = liveSession({ runsMs: 0, stepMs: 100 });
  const configFile = path.join(s.cwd, "detail.json5");
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      globals: { experimentalPane: true },
      variables: {
        detail: { kind: "state", key: "seam.detail", default: "off" },
        detailed: {
          kind: "shell",
          command: "seam-detail",
          cache: { key: "{{ .detail }}" },
        },
      },
      segments: {
        runs: { template: "detail={{ .detail }} run={{ .detailed }}" },
      },
      root: { h: ["runs"] },
    }),
  );
  s.launcher.program(shell("seam-detail"), runsFor(2000, exits(0, "old")));
  await s.requestFrom(s.cwd, configFile);
  // The click's key runs a command that prints what the old key's did not.
  s.launcher.program(shell("seam-detail"), runsFor(2000, exits(0, "new")));
  // The pane lane draws the click's frame at once, with the new run out.
  cleanups.push(s.follow("pane"));
  const from = s.drawn.length;
  const { file } = await recordHeld(s, "moved-key.jsonl", async () => {
    const frames = [await s.requestFrom(s.cwd, configFile)];
    pick(s, [{ key: "seam.detail", value: "on" }]);
    await s.after(500);
    await s.after(3000);
    frames.push(await s.requestFrom(s.cwd, configFile));
    return frames;
  });
  const liveFrames = s.drawn.slice(from);
  const liveText = liveFrames.map(textOf);
  expect(liveText[0]).toContain("detail=off run=old");
  expect(liveText.at(-1)).toContain("detail=on run=new");
  // A frame of the click's, drawn before its run landed, shows the old run.
  expect(liveText).toContainEqual(
    expect.stringContaining("detail=on run=old"),
  );
  const replay = await replayFile(file, configFile);
  expect(replay.reads).toEqual([]);
  expect(replay.started).toEqual([]);
  expect(replay.frames.map(textOf)).toEqual(liveText);
});

// A frame compared whole: what it draws, when it next changes, and whether it
// can move.
const whole = (frame: Frame) => ({
  rows: frame.rows,
  nextChange: frame.nextChange,
  motion: frame.motion,
});

test("a session recorded with a standing warning and a lane following replays the daemon's answers and the lane's frames whole: the lane toggles reading the feeds, and the viewer open on the warning", async () => {
  const s = liveSession();
  // The pane lane switched on, by a key written twice: the settings menu
  // cannot edit the file, which the load warns of from then on.
  const configFile = path.join(path.dirname(s.configFile), "lane.json5");
  fs.writeFileSync(
    configFile,
    CONFIG.replace(
      "segments: {",
      "globals: { experimentalPane: true, experimentalPane: true },\n  segments: {",
    ),
  );
  await s.requestFrom(s.cwd, configFile);
  cleanups.push(s.follow("pane"));
  const from = s.drawn.length;
  const { file, liveFrames: answers } = await recordHeld(
    s,
    "lane.jsonl",
    async (file) => {
      const frames: Frame[] = [];
      await s.after(1000);
      frames.push(await s.requestFrom(s.cwd, configFile));
      // The settings menu open on its 🧪 toggles, where each lane's toggle
      // reads that lane's feed.
      pick(s, [
        { key: SETTINGS_ANCHOR, value: SETTINGS_OPEN },
        { key: "candybar.tab", value: "config" },
        { key: "menus.candybar_pickers", value: "toggles" },
      ]);
      await s.after(1000);
      frames.push(await s.requestFrom(s.cwd, configFile));
      // The viewer opened on the warning, standing in for the bar, as the
      // indicator's click opens it: on the first message of the list the
      // daemon's draw built, which the recording holds so far.
      const answered = readRecording(file).lines.findLast(
        (line) => line.kind === "draw",
      );
      if (answered?.kind !== "draw") throw new Error("no draw recorded yet");
      pick(s, [
        {
          key: DIAGNOSTICS_VIEWING,
          value: diagnosticsProjection(answered.diagnostics).open,
        },
      ]);
      await s.after(1000);
      frames.push(await s.requestFrom(s.cwd, configFile));
      await s.after(500);
      return frames;
    },
  );
  const liveFrames = s.drawn.slice(from);
  const [plain, toggles, viewer] = answers.map(textOf);
  expect(plain).toContain("⚠ 1");
  expect(toggles).toMatch(/pane[^\n]* \d+ fps/u);
  expect(viewer).toContain("duplicate key");
  // The lane drew frames of its own between the answers, through the same
  // views, and the recording carries them with the feeds they read.
  const draws = readRecording(file).lines.flatMap((line) =>
    line.kind === "draw" ? [line] : [],
  );
  expect(draws.map((line) => line.drawing.by)).toEqual(
    liveFrames.map((frame) =>
      answers.includes(frame) ? "request" : "feed",
    ),
  );
  expect(draws.filter((line) => line.drawing.by === "feed").length).toBeGreaterThan(
    answers.length,
  );
  expect(draws.every((line) => line.feeds.pane.subscribers === 1)).toBe(true);
  const replay = await replayFile(file, configFile);
  expect(replay.reads).toEqual([]);
  expect(replay.started).toEqual([]);
  // The demo says the load's warning, as `check` does.
  expect(replay.said).toEqual([expect.stringContaining("duplicate key")]);
  expect(replay.frames.map(whole)).toEqual(liveFrames.map(whole));
});

test("a config that reads two built-ins records documents holding only what it declared, and the replay draws the bars the live renderer drew", async () => {
  const s = liveSession(HELD, `{ root: { h: ["gitaculous", "metrics"] } }`);
  await s.requestFrom(s.cwd, s.configFile);
  const file = path.join(tempDir("ccb-seam-declared-"), "bar.jsonl");
  const recorded = recordToFile(
    s.live.recorder,
    s.clock,
    sessionIdOf(SID),
    file,
    7,
    stays(),
  );
  const liveFrames: Frame[] = [];
  for (const offset of [1000, 2000, 2000]) {
    await s.after(offset);
    liveFrames.push(await s.requestFrom(s.cwd, s.configFile));
  }
  await s.after(2000);
  await recorded;
  // Nothing the config does not read was gathered: no key for it in any
  // document, rather than a pending that never lands. The config merges over
  // the bundled default, whose presets place every built-in but tmux and
  // declare them though unpicked.
  const keys = documentsOf(readRecording(file)).map(({ facts }) =>
    Object.keys(facts.builtins),
  );
  for (const held of keys) {
    expect(held).toEqual(keys[0]);
    expect(held).toEqual(expect.arrayContaining(["git", "metrics"]));
    expect(held).not.toContain("tmux");
  }
  expect(liveFrames.map(textOf)[0]).toContain("main");
  expect(warned(liveFrames)).toBe(false);

  const replay = await replayFile(file, s.configFile);
  expect(replay.reads).toEqual([]);
  expect(replay.started).toEqual([]);
  expect(replay.said).toEqual([]);
  expect(replay.frames.map((f) => f.rows)).toEqual(
    liveFrames.map((f) => f.rows),
  );
});
