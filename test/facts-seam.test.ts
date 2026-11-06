// [LAW:verifiable-goals] The test that defines the facts seam
// (docs/design/gather-and-renderer.md §1): a renderer given a recorded facts
// stream and no owners draws the bars the live renderer drew, with zero
// filesystem reads and zero spawned processes after its load. And the
// recording that proves it is the one a person makes for a bug report: a
// session's stream written out of the daemon's render cache by its recorder
// (src/daemon/session-recorder.ts), read back by the one parser, replayed by
// the demo (src/demo/play.ts).
//
// The live half is a render-cache rig in this worker, built as the daemon
// builds its cache (`recordedCache` over `inProcessFacts`) and settling each
// request as the daemon's request path does (`settleRequest`), because the
// boot ratchet admits no new booting case (.claude/memory/testing.md). Each
// live frame is drawn only once every fact has landed, so a line stamped
// after a draw never exists: the recording at an instant is what the frame at
// that instant drew from. Every frame, live and replayed, is drawn by the
// demo's one draw.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NO_FILE_EVENTS } from "../src/daemon/cache/file-events";
import { RenderCache, type SessionView } from "../src/daemon/cache/render";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import {
  inProcessFacts,
  recordingFacts,
  type Facts,
} from "../src/daemon/facts-source";
import { homeOf } from "../src/daemon/home";
import { cacheDir, locations, stateDir } from "../src/daemon/paths";
import { createPayloadProviders } from "../src/daemon/payload-providers";
import { parseClientHints } from "../src/daemon/protocol";
import type { ViewFacts } from "../src/daemon/render-payload";
import { sessionIdOf } from "../src/daemon/session-id";
import {
  recordedCache,
  recordToFile,
  settleRequest,
  type SessionRecorder,
} from "../src/daemon/session-recorder";
import {
  sessionSource,
  type SessionSource,
} from "../src/daemon/session-source";
import { SessionState } from "../src/daemon/session-state";
import { EMPTY_HISTORY_DEPTH } from "../src/daemon/settings-history";
import { newUpdateFact, type UpdateFact } from "../src/daemon/update-fact";
import {
  drawDemoFrame,
  loadDemo,
  playDemo,
  readRecording,
  RecordingUnreadable,
} from "../src/demo/play";
import type { RenderedLine } from "../src/dsl/node-registry";
import {
  formatLine,
  parseRecording,
  type RecordingLine,
} from "../src/facts/recording";
import { FACTS_VERSION } from "../src/facts/session-facts";
import type { Host } from "../src/host";
import { exits } from "../src/proc/spawner-fake";
import { SessionEffects } from "../src/render/effect";
import type { Frame } from "../src/render/frame";
import { textOf } from "../src/render/frame";
import type { Timekeeper } from "../src/time";
import { instantAt } from "../src/utils/instant";
import type { DaemonLogger } from "../src/utils/logger";
import { RefreshLedger } from "../src/utils/refresh-ledger";
import { SourceRuns } from "../src/var-system/source-runs";
import { fakeLauncher, turns } from "./helpers/fake-launcher";
import { bareGates } from "./helpers/gates";
import { heldClock, type HeldClock } from "./helpers/held-clock";
import { hostOf } from "./helpers/host";
import { TEST_SIGNER } from "./helpers/link-signer";
import { until } from "./helpers/until";

jest.setTimeout(30_000);

const SID = "seam00a1-b2c3-4d5e-8f6a-7b8c9d0e1f2a";
const AT = new Date(1_700_000_000_000);
const WIDTH = 160;
const PLUGIN_SOURCE = "plugins.p.status";

// A config placing every built-in, and one declared plugin source.
const CONFIG = `{
  plugins: ["./p/plugin.json5"],
  segments: { status: { template: 'status={{ .plugins.p.status.home }}' } },
  root: { h: [
    "gitaculous", "gitPr", "session", "today", "context", "metrics",
    "activity", "speed", "cacheTimer", "autocompact", "tmux", "host", "status",
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
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  jest.restoreAllMocks();
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
function sessionDir(): { cwd: string; configFile: string } {
  const cwd = tempDir("ccb-seam-cwd-");
  fs.mkdirSync(path.join(cwd, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(cwd, ".git", "refs", "heads", "main"), "c0ffee\n");
  fs.writeFileSync(path.join(cwd, ".git", "index"), "");
  const configFile = path.join(cwd, "config.json5");
  fs.writeFileSync(configFile, CONFIG);
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

// What git, the forge and tmux answer the live owners.
function scriptPrograms(launcher: ReturnType<typeof fakeLauncher>): void {
  const { spawner } = launcher;
  spawner.program(
    (bin, args) => bin === "git" && args[0] === "status",
    exits(
      0,
      "# branch.oid c0ffee0123456789\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -0\n",
    ),
  );
  spawner.program(
    (bin, args) => bin === "git" && args[0] === "config",
    exits(0, "remote.origin.url git@github.com:acme/widget.git\n"),
  );
  spawner.program(
    (bin, args) => bin === "git" && args[0] === "describe",
    exits(128, "", "fatal: No names found, cannot describe anything.\n"),
  );
  spawner.program(
    (bin, args) => bin === "git" && args[0] === "log",
    exits(0, "1700000000\n"),
  );
  spawner.program(
    (bin) => bin === "gh",
    exits(
      0,
      JSON.stringify({
        number: 7,
        state: "OPEN",
        url: "https://github.com/acme/widget/pull/7",
        headRefOid: "c0ffee0123456789",
      }),
    ),
  );
  spawner.program((bin) => bin === "tmux", exits(0, "work\n"));
}

function request(
  cwd: string,
  home: string,
  claudeConfigDir: string,
): ViewFacts {
  return {
    sessionId: sessionIdOf(SID),
    hookData: {
      hook_event_name: "Status",
      session_id: SID,
      transcript_path: path.join(home, "transcript.jsonl"),
      cwd,
      model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
      workspace: { current_dir: cwd, project_dir: cwd },
    },
    cwd,
    hints: parseClientHints({
      termCols: WIDTH,
      termRows: 40,
      ssh: true,
      tmux: {
        socket: path.join(home, "tmux.sock"),
        pane: "%0",
        truecolor: null,
      },
      claudeConfigDir,
    }),
  };
}

interface Rig {
  readonly cache: RenderCache<SessionSource>;
  readonly recorder: SessionRecorder;
  readonly lines: string[];
}

// The daemon's own composition of a render cache over providers
// (src/daemon/daemon.ts), its recorder wired over it, its facts source chosen
// by the caller. `failsFor` is a directory whose view's source throws as it
// opens, standing in for any view that fails after its follow was taken.
function rig(
  host: Host,
  clock: Timekeeper,
  launcher: ReturnType<typeof fakeLauncher>["launcher"],
  factsOf: (
    providers: ReturnType<typeof createPayloadProviders>,
    update: UpdateFact,
  ) => Facts,
  failsFor: string | null = null,
): Rig {
  const lines: string[] = [];
  const log: DaemonLogger = (level, message) => {
    lines.push(`${level} ${message}`);
  };
  const watchers = new WatcherRegistry({ clock, logger: log });
  const home = homeOf(host);
  const providers = createPayloadProviders({
    clock,
    launcher,
    host,
    cacheDir: cacheDir(home),
    watchers,
    fileEvents: NO_FILE_EVENTS,
    logger: log,
    ledger: new RefreshLedger(log),
  });
  const sessionState = new SessionState();
  const update = newUpdateFact();
  const runs = new SourceRuns({ launcher, clock });
  const source = sessionSource({
    providers,
    sessionState,
    history: () => EMPTY_HISTORY_DEPTH,
    navigation: () => 0,
  });
  const { cache, recorder } = recordedCache(
    (recording) =>
      new RenderCache<SessionSource>(
        {
          clock,
          stateDir: stateDir(home),
          locations: locations(host, home),
          runs,
          sessionState,
          watchers,
          storage: providers.managedStorage,
          signer: TEST_SIGNER,
          gates: bareGates(),
          log,
          facts: factsOf(providers, update),
          source: (view) => {
            if (view.declared().facts.cwd === failsFor) {
              throw new Error(`the source of ${failsFor} throws as it opens`);
            }
            return source(view);
          },
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
    runs.close();
    providers.gitProvider.close();
    providers.usageStore.close();
    providers.tmuxService.close();
    providers.managedStorage.close();
    watchers.closeAll();
  });
  return { cache, recorder, lines };
}

// Every fact of the document answered: the owners' children run on the held
// clock's zero-advances, the transcript folds on real I/O.
async function landed(
  clock: HeldClock,
  view: SessionView<SessionSource>,
): Promise<void> {
  const pending = (): string[] => {
    const { builtins, sources } = view.source.facts();
    return [...Object.entries(builtins), ...Object.entries(sources)]
      .filter(([, fact]) => fact.kind === "pending")
      .map(([name]) => name);
  };
  await until(
    async () => {
      clock.advance(0);
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

// A live session over the in-process arm: its directory, its home, its held
// clock and scripted programs, and its rig.
function liveSession() {
  const dir = sessionDir();
  const { home, claudeConfigDir } = homeDir();
  const clock = heldClock(AT);
  const launcher = fakeLauncher(clock);
  scriptPrograms(launcher);
  const live = rig(
    hostOf({}, { home, tmp: home }),
    clock,
    launcher.launcher,
    (providers, update) =>
      inProcessFacts({ providers, update: () => update.get() }),
    path.join(home, "fails"),
  );
  const effects = new SessionEffects<RenderedLine>(SID);
  const drawn = warnings();
  // One request of the session's from `cwd`, at the clock's instant, as the
  // daemon's request path takes one: the view declared with it, the request
  // noted and its view settled, every fact landed, the frame drawn.
  const requestFrom = async (
    cwd: string,
    configFile: string,
    burnMs = 0,
  ): Promise<Frame> => {
    const at = instantAt(clock);
    // What the request path spends between reading the request's instant and
    // declaring its view: what that declaration stamps is later than `at`.
    clock.burn(burnMs);
    using held = live.cache.holdSession(
      cwd,
      cwd,
      configFile,
      request(cwd, home, claudeConfigDir),
    );
    const settling = settleRequest(live.recorder, held.view, at);
    await landed(clock, held.view);
    await settling.landed;
    return drawDemoFrame(held.view, at, effects, drawn.warn);
  };
  const after = async (ms: number): Promise<void> => {
    clock.advance(ms);
    await turns();
  };
  return { ...dir, home, clock, live, drawn, requestFrom, after };
}

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
// document, its config loaded before the instruments and its frames drawn
// with every read and spawn counted.
async function replayFile(
  file: string,
  cwd: string,
  configFile: string,
  home: string,
): Promise<{
  frames: Frame[];
  reads: string[];
  started: readonly unknown[];
  said: string[];
}> {
  const { recording, ticks } = readRecording(file);
  const clock = heldClock(new Date(recording.facts[0].at * 1000));
  const launcher = fakeLauncher(clock);
  const replayHome = tempDir("ccb-seam-replay-");
  const host = hostOf({}, { home: replayHome, tmp: replayHome });
  const drawn = warnings();
  const log: DaemonLogger = (level, message) =>
    drawn.warn(`${level} ${message}`);
  // The load: the config and the plugin are read here, before the instruments.
  using loaded = loadDemo({
    world: { host, home: homeOf(host), launcher: launcher.launcher, clock },
    stateDir: stateDir(homeOf(host)),
    signer: TEST_SIGNER,
    configPath: configFile,
    cwd,
    warn: drawn.warn,
  });
  const reads = spyReads();
  const frames: Frame[] = [];
  await playDemo({
    loaded,
    cwd,
    facts: recordingFacts(recording, clock),
    // Whose home `~` names: the live session's, which the payload carries.
    home,
    log,
    clock,
    ticks,
    pace: async (ms) => clock.advance(ms),
    frame: (frame) => frames.push(frame),
  });
  const read = reads();
  jest.restoreAllMocks();
  return { frames, reads: read, started: launcher.started(), said: drawn.said };
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
  const { lines, requests } = await recorded;
  expect(requests).toBe(3);
  const text = fs.readFileSync(file, "utf8");
  expect(text.split("\n").filter((l) => l !== "")).toHaveLength(lines);
  // The live bar drew real facts: the branch, its PR, the tmux session, the
  // plugin's document.
  const liveText = liveFrames.map(textOf);
  expect(liveText[0]).toContain("main");
  expect(liveText[0]).toContain("#7");
  expect(liveText[0]).toContain("tmux:work");
  expect(liveText[0]).toContain("status=/h/seam");
  expect(s.drawn.said).toEqual([]);

  const replay = await replayFile(file, s.cwd, s.configFile, s.home);
  expect(replay.reads).toEqual([]);
  expect(replay.started).toEqual([]);
  expect(replay.said).toEqual([]);
  expect(replay.frames.map(textOf)).toEqual(liveText);
  expect(replay.frames.map((f) => f.rows)).toEqual(
    liveFrames.map((f) => f.rows),
  );
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
  expect((await recorded).requests).toBe(3);
  const { recording } = readRecording(file);
  // The recording opens on the first view's current document, and the
  // successor's opening document starts its sequence again, once.
  const seqs = recording.facts.map((line) => line.facts.seq);
  expect(seqs[0]).toBeGreaterThan(1);
  expect(seqs.filter((seq) => seq === 1)).toHaveLength(1);
  expect(seqs.indexOf(1)).toBeGreaterThan(0);
  const replay = await replayFile(file, s.cwd, s.configFile, s.home);
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
  // The next view's opening document, then its request and what landed.
  const reopened = written.slice(before);
  expect(reopened[0]).toMatchObject({ kind: "facts", facts: { seq: 1 } });
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
  const { lines, requests } = await recorded;
  const text = fs.readFileSync(file, "utf8");
  expect(text.split("\n").filter((l) => l !== "")).toHaveLength(lines);
  expect(requests).toBe(1);
  expect(parseRecording(text).requests).toHaveLength(1);
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
  const { lines, requests } = await recorded;
  await s.after(1000);
  await s.requestFrom(s.cwd, s.configFile);
  const text = fs.readFileSync(file, "utf8");
  expect(text.split("\n").filter((l) => l !== "")).toHaveLength(lines);
  expect(requests).toBe(1);
  expect(parseRecording(text).requests).toHaveLength(1);
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

test("a recording of another facts version is refused by the demo naming the file", () => {
  const file = path.join(tempDir("ccb-seam-out-"), "v-next.jsonl");
  fs.writeFileSync(
    file,
    `${JSON.stringify({ kind: "recording", v: FACTS_VERSION + 1, session: SID })}\n`,
  );
  expect(() => readRecording(file)).toThrow(RecordingUnreadable);
  expect(() => readRecording(file)).toThrow(
    `${file} is a facts v${FACTS_VERSION + 1} recording; this build reads v${FACTS_VERSION}`,
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
  const replayHome = tempDir("ccb-seam-replay-");
  const replayClock = heldClock(new Date(recording.facts[0].at * 1000));
  const replayLauncher = fakeLauncher(replayClock);
  const replay = rig(
    hostOf({}, { home: replayHome, tmp: replayHome }),
    replayClock,
    replayLauncher.launcher,
    () => recordingFacts(recording, replayClock),
  );
  // The load: the config and the plugin are read here, before the instruments.
  replay.cache.getOrCreate(s.cwd, s.cwd, s.configFile);
  const reads = spyReads();
  const effects = new SessionEffects<RenderedLine>(SID);
  const drawn = warnings();
  const replayFrames: Frame[] = [];
  let elapsed = 0;
  for (const { at, request: recorded } of recording.requests) {
    const offset = Math.round((at - recording.facts[0].at) * 1000);
    replayClock.advance(offset - elapsed);
    elapsed = offset;
    using held = replay.cache.holdSession(s.cwd, s.cwd, s.configFile, recorded);
    await settleRequest(replay.recorder, held.view, at).landed;
    replayFrames.push(drawDemoFrame(held.view, at, effects, drawn.warn));
  }
  expect(reads()).toEqual([]);
  expect(replayLauncher.started()).toEqual([]);
  expect(drawn.said).toEqual([]);
  expect(replayFrames.map(textOf)).toEqual(liveFrames.map(textOf));
  expect(replayFrames.map((f) => f.rows)).toEqual(
    liveFrames.map((f) => f.rows),
  );
  expect(PLUGIN_SOURCE in recording.facts[0].facts.sources).toBe(true);
});
