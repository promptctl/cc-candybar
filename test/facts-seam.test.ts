// [LAW:verifiable-goals] The test that defines the facts seam
// (docs/design/gather-and-renderer.md §1): a renderer given a recorded facts
// stream and no owners draws the bars the live renderer drew, with zero
// filesystem reads and zero spawned processes after its load. Two render-cache
// rigs in this worker, drawn through the daemon's own openView, sessionSource
// and drawDsl: the live one over the in-process arm, its follow recorded; the
// replay one over the recording arm, instrumented. The rigs stand in for two
// daemons because the boot ratchet admits no new booting case
// (.claude/memory/testing.md), and after this change the daemon's request
// path holds no owner by type (src/daemon/draw-bar.ts).
//
// The live half draws each frame only once every fact has landed, so a line
// stamped after a draw never exists: the recording at an instant is what the
// frame at that instant drew from.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UNFOLLOWED_FEEDS } from "../src/config/lanes";
import { NO_FILE_EVENTS } from "../src/daemon/cache/file-events";
import { RenderCache, type SessionView } from "../src/daemon/cache/render";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import {
  inProcessFacts,
  recordedFacts,
  recordingFacts,
  type Facts,
} from "../src/daemon/facts-source";
import { locations, stateDir } from "../src/daemon/paths";
import { createPayloadProviders } from "../src/daemon/payload-providers";
import { parseClientHints } from "../src/daemon/protocol";
import { renderOptionsOf, todayOf, type ViewFacts } from "../src/daemon/render-payload";
import { sessionIdOf } from "../src/daemon/session-id";
import { sessionSource, type SessionSource } from "../src/daemon/session-source";
import { SessionState } from "../src/daemon/session-state";
import { EMPTY_HISTORY_DEPTH } from "../src/daemon/settings-history";
import { newUpdateFact, type UpdateFact } from "../src/daemon/update-fact";
import { drawDsl } from "../src/dsl/render";
import type { FactsLine } from "../src/facts/recording";
import type { Host } from "../src/host";
import { exits } from "../src/proc/spawner-fake";
import type { Frame } from "../src/render/frame";
import { textOf } from "../src/render/frame";
import type { Timekeeper } from "../src/time";
import { instantAt, type Instant } from "../src/utils/instant";
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
// The instants the five requests arrive at, from the first.
const OFFSETS_MS = [0, 2000, 4000, 6000, 8000];
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

function request(cwd: string, home: string, claudeConfigDir: string): ViewFacts {
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
      tmux: { socket: path.join(home, "tmux.sock"), pane: "%0", truecolor: null },
      claudeConfigDir,
    }),
  };
}

interface Rig {
  readonly cache: RenderCache<SessionSource>;
  readonly lines: string[];
}

// The daemon's own composition of a render cache over providers
// (src/daemon/daemon.ts), its facts source chosen by the caller.
function rig(
  host: Host,
  clock: Timekeeper,
  launcher: ReturnType<typeof fakeLauncher>["launcher"],
  factsOf: (
    providers: ReturnType<typeof createPayloadProviders>,
    update: UpdateFact,
    log: DaemonLogger,
  ) => Facts,
): Rig {
  const lines: string[] = [];
  const log: DaemonLogger = (level, message) => {
    lines.push(`${level} ${message}`);
  };
  const watchers = new WatcherRegistry({ clock, logger: log });
  const providers = createPayloadProviders({
    clock,
    launcher,
    host,
    watchers,
    fileEvents: NO_FILE_EVENTS,
    logger: log,
    ledger: new RefreshLedger(log),
  });
  const sessionState = new SessionState();
  const update = newUpdateFact();
  const runs = new SourceRuns({ launcher, clock });
  const cache = new RenderCache<SessionSource>(
    {
      clock,
      stateDir: stateDir(host),
      locations: locations(host),
      env: host.env,
      runs,
      sessionState,
      watchers,
      storage: providers.managedStorage,
      signer: TEST_SIGNER,
      gates: bareGates(),
      log,
      facts: factsOf(providers, update, log),
      source: sessionSource({
        providers,
        sessionState,
        history: () => EMPTY_HISTORY_DEPTH,
        navigation: () => 0,
      }),
    },
    { budgetBytes: () => 1024 * 1024 * 1024 },
  );
  cleanups.push(() => {
    cache.close();
    runs.close();
    providers.gitProvider.close();
    providers.usageStore.close();
    providers.tmuxService.close();
    providers.managedStorage.close();
    watchers.closeAll();
  });
  return { cache, lines };
}

// One frame of the view, as the demo and the daemon draw one.
function draw(view: SessionView<SessionSource>, at: Instant): Frame["rows"] {
  const effective = view.source.effective();
  const errors: string[] = [];
  const { frame } = drawDsl(
    view.state.config,
    view.state.compiled,
    view.store,
    view.registry,
    {
      drawing: { by: "request" },
      feeds: UNFOLLOWED_FEEDS,
      today: todayOf(view.source.facts().builtins.today, at),
    },
    at,
    renderOptionsOf(effective, WIDTH),
    { onSegmentError: (id, message) => errors.push(`${id}: ${message}`) },
    effective,
  );
  expect(errors).toEqual([]);
  return frame.rows;
}

// Every fact of the document answered: the owners' children run on the held
// clock's zero-advances, the transcript folds on real I/O.
async function landed(
  clock: HeldClock,
  view: SessionView<SessionSource>,
): Promise<void> {
  const pending = (): string[] => {
    const { builtins, sources } = view.source.facts();
    return [
      ...Object.entries(builtins),
      ...Object.entries(sources),
    ]
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

test("a recording of a session's facts replays into the bars the live renderer drew, with nothing read and nothing spawned", async () => {
  // ── Live ────────────────────────────────────────────────────────────────
  const { cwd, configFile } = sessionDir();
  const { home, claudeConfigDir } = homeDir();
  const liveClock = heldClock(AT);
  const liveLauncher = fakeLauncher(liveClock);
  scriptPrograms(liveLauncher);
  const recording: FactsLine[] = [];
  const live = rig(
    hostOf({}, { home, tmp: home }),
    liveClock,
    liveLauncher.launcher,
    (providers, update, log) =>
      recordedFacts(
        inProcessFacts({ providers, update: () => update.get() }),
        (line) => recording.push(line),
        log,
      ),
  );
  const liveFrames: Frame["rows"][] = [];
  let elapsed = 0;
  for (const offset of OFFSETS_MS) {
    liveClock.advance(offset - elapsed);
    elapsed = offset;
    await turns();
    const at = instantAt(liveClock);
    using held = live.cache.holdSession(
      cwd,
      cwd,
      configFile,
      request(cwd, home, claudeConfigDir),
    );
    const settling = held.view.settle(at);
    await landed(liveClock, held.view);
    await settling.landed;
    liveFrames.push(draw(held.view, at));
  }
  // The live bar drew real facts: the branch, its PR, the tmux session, the
  // plugin's document.
  const liveText = liveFrames.map((rows) => textOf({ rows }));
  expect(liveText[0]).toContain("main");
  expect(liveText[0]).toContain("#7");
  expect(liveText[0]).toContain("tmux:work");
  expect(liveText[0]).toContain("status=/h/seam");
  expect(recording.length).toBeGreaterThan(1);
  expect(recording[0]!.at).toBe(instantAt(heldClock(AT)));

  // ── Replay ──────────────────────────────────────────────────────────────
  const replayHome = tempDir("ccb-seam-replay-");
  const replayClock = heldClock(new Date(recording[0]!.at * 1000));
  const replayLauncher = fakeLauncher(replayClock);
  const replay = rig(
    hostOf({}, { home: replayHome, tmp: replayHome }),
    replayClock,
    replayLauncher.launcher,
    () => recordingFacts(recording, replayClock),
  );
  // The load: the config and the plugin are read here, before the instruments.
  replay.cache.getOrCreate(cwd, cwd, configFile);
  // Every read call of fs and fs/promises, with no allow-list: a read inside
  // a draw is a failure whoever makes it.
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
  const PROMISE_READS = ["readFile", "readdir", "stat", "lstat", "open"] as const;
  const reads = [
    ...SYNC_READS.map((name) => jest.spyOn(fs, name).mockName(`fs.${name}`)),
    ...PROMISE_READS.map((name) =>
      jest.spyOn(fsp, name).mockName(`fs/promises.${name}`),
    ),
  ];
  const replayFrames: Frame["rows"][] = [];
  elapsed = 0;
  for (const offset of OFFSETS_MS) {
    replayClock.advance(offset - elapsed);
    elapsed = offset;
    const at = instantAt(replayClock);
    using held = replay.cache.holdSession(
      cwd,
      cwd,
      configFile,
      request(cwd, home, claudeConfigDir),
    );
    await held.view.settle(at).landed;
    replayFrames.push(draw(held.view, at));
  }
  const read = reads
    .flatMap((spy) => spy.mock.calls.map((call) => `${spy.getMockName()}(${String(call[0])})`));
  expect(read).toEqual([]);
  expect(replayLauncher.started()).toEqual([]);
  expect(replayFrames.map((rows) => textOf({ rows }))).toEqual(liveText);
  expect(replayFrames).toEqual(liveFrames);
});
