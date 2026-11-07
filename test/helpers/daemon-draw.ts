// A daemon's draw composed in the worker as the daemon composes it
// (src/daemon/daemon.ts), on a held clock, because the boot ratchet admits no
// new booting case (.claude/memory/testing.md). Each tick is the daemon's reply
// to a render request (src/daemon/reply.ts), and the list a draw built is read
// from the session's recording, which carries the list the door's indicator
// counts and its viewer pages.


import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reaction } from "mobx";

import { NO_FILE_EVENTS } from "../../src/daemon/cache/file-events";
import { RenderCache } from "../../src/daemon/cache/render";
import { WatcherRegistry } from "../../src/daemon/cache/watchers";
import type { DaemonParts } from "../../src/daemon/daemon-parts";
import { drawAnswer, renderFrame, viewLanes } from "../../src/daemon/draw-bar";
import { inProcessFacts } from "../../src/daemon/facts-source";
import { FEED_PERIODS, FrameFeeds } from "../../src/daemon/frame-feed";
import { homeOf } from "../../src/daemon/home";
import { JournalTurns } from "../../src/daemon/journal-turns";
import { heldSessionUnder } from "../../src/daemon/lane-edge";
import type { LaneEncoders } from "../../src/daemon/lane-frames";
import { MenuIdle } from "../../src/daemon/menu-idle";
import { locations, stateDir, storedRoot } from "../../src/daemon/paths";
import { createPayloadProviders } from "../../src/daemon/payload-providers";
import { PROTOCOL_VERSION, type ClientHints } from "../../src/daemon/protocol";
import type { CheckedRenderRequest } from "../../src/daemon/render-checkpoint";
import { RenderSightings } from "../../src/daemon/render-sightings";
import { RenderWarningRecords } from "../../src/daemon/render-warnings";
import { replyTo } from "../../src/daemon/reply";
import { sessionIdOf } from "../../src/daemon/session-id";
import { recordedCache } from "../../src/daemon/session-recorder";
import { sessionSource, type SessionSource } from "../../src/daemon/session-source";
import { SessionState } from "../../src/daemon/session-state";
import { RuntimeStats } from "../../src/daemon/stats";
import { newUpdateFact } from "../../src/daemon/update-fact";
import { NEVER_CLICKED } from "../../src/demo/play";
import { systemFilesystem } from "../../src/disk/system-filesystem";
import type { RenderedLine } from "../../src/dsl/node-registry";
import type { RecordingLine, SessionRequest } from "../../src/facts/recording";
import { EffectSessions } from "../../src/render/effect";
import type { DiagnosticList } from "../../src/render/diagnostics";
import type { Frame } from "../../src/render/frame";
import { offlinePricing } from "../../src/segments/pricing";
import { instantAt } from "../../src/utils/instant";
import type { DaemonLogger } from "../../src/utils/logger";
import { RefreshLedger } from "../../src/utils/refresh-ledger";
import { SourceRuns } from "../../src/var-system/source-runs";
import { CLAUDE_START, claudeHolds } from "./claude-record";
import { testVerbContext } from "./click";
import { configFlag, renderBody } from "./daemon-e2e";
import { fakeLauncher } from "./fake-launcher";
import { bareGates } from "./gates";
import { heldClock } from "./held-clock";
import { hostOf } from "./host";
import { TEST_LINKS } from "./link-signer";
import type { GitEnvAsk } from "../../src/git-env";

// What a case states of the daemon it draws through: its config, the tmux pane
// its client runs in, what git named at the daemon's start, and where its
// teardown goes.
export interface DrawnDaemon {
  readonly config: string;
  readonly pane: string;
  readonly gitEnv: GitEnvAsk;
  readonly cleanup: (fn: () => void) => void;
}

// The daemon's request path over a home of its own: the checkpoint that
// stamps a request's pane from the Claude Code records under the home, the
// request arm over the real journal turns, and the daemon's draw over a
// render cache composed as the daemon composes it.
export function daemonDraw({ config, pane, gitEnv, cleanup }: DrawnDaemon) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-pane-draw-")));
  cleanup(() => fs.rmSync(home, { recursive: true, force: true }));
  const claudeConfigDir = path.join(home, "claude");
  const configFile = path.join(home, "pane.json5");
  fs.writeFileSync(configFile, config);
  const host = hostOf({}, { home, tmp: home });
  const rendererHome = homeOf(host);
  const clock = heldClock(new Date(1_700_000_000_000));
  // No program is scripted: a source that launches one draws its failure,
  // which is no session-pane ⚠.
  const { launcher } = fakeLauncher(clock);
  const said: string[] = [];
  const log: DaemonLogger = (level, message) => void said.push(`${level} ${message}`);
  // [LAW:no-silent-failure] An error the daemon only logs fails the case:
  // checked at every tick, and once more after the last, before teardown.
  const unlogged = (): void => {
    const errors = said.filter((line) => line.startsWith("error "));
    if (errors.length > 0) throw new Error(`the daemon logged errors:\n${errors.join("\n")}`);
  };
  const watchers = new WatcherRegistry({ filesystem: systemFilesystem, clock, logger: log });
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
  // [LAW:single-enforcer] The store is held by the journal's turns, as the
  // daemon's is, so a write outside the request arm's turn throws here too.
  const turns = new JournalTurns();
  const sessionState = new SessionState(turns);
  const update = newUpdateFact();
  // [LAW:one-source-of-truth] One of each part the daemon hands both its
  // verbs and its draw (src/daemon/daemon.ts).
  const gates = bareGates();
  const sightings = new RenderSightings();
  const runs = new SourceRuns({ launcher, clock });
  const source = sessionSource({
    providers,
    sessionState,
    stateGates: gates.state,
    history: () => NEVER_CLICKED.history,
    navigation: () => NEVER_CLICKED.back,
  });
  const menuIdle = new MenuIdle({
    clock,
    now: () => instantAt(clock),
    close: async () => {},
    failed: (sessionId, error) => said.push(`error menu-idle sid=${sessionId}: ${String(error)}`),
  });
  const { cache, recorder } = recordedCache(
    (recording) =>
      new RenderCache<SessionSource, SessionRequest>(
        {
          clock,
          stateDir: stateDir(rendererHome),
          locations: locations(host, rendererHome),
          sessionState,
          watchers,
          storage: providers.managedStorage,
          links: TEST_LINKS,
          gates,
          log,
          facts: inProcessFacts({ providers, update: () => update.get(), runs }),
          source,
        },
        { budgetBytes: () => 1024 * 1024 * 1024, observers: recording },
      ),
    log,
  );
  const { arrival: _arrival, described: _described, gone: _gone, ...testCtx } = testVerbContext(
    sessionState,
    undefined,
    undefined,
    host,
    turns,
  );
  const verbCtx = {
    ...testCtx,
    gates,
    log,
    launcher,
    now: () => instantAt(clock),
    clients: sightings,
  };
  const heldSession = heldSessionUnder(home);
  let feeds: FrameFeeds<CheckedRenderRequest> | null = null;
  // [LAW:single-enforcer] The parts the daemon's reply and draw read, its run
  // of mismatched stamps the one the request arm writes, and a stand-in for
  // each that has nothing to warn of here (no update, no link-id fault, no
  // launch).
  const parts: DaemonParts = {
    home,
    storedRoot: storedRoot(rendererHome),
    heldSession,
    rendererName: "pane-draw",
    clock,
    log,
    stats: new RuntimeStats(clock),
    renderSightings: sightings,
    recorder,
    sessionState,
    journalTurns: turns,
    mismatchRuns: verbCtx.mismatchRuns,
    renderCache: cache,
    payloadProviders: providers,
    menuIdle,
    links: TEST_LINKS,
    fileEvents: NO_FILE_EVENTS,
    gitEnv,
    renderWarnings: new RenderWarningRecords(),
    effectSessions: new EffectSessions<RenderedLine>(),
    updateWatch: { notice: () => [], error: () => null },
    linkIds: { error: () => null },
    launcher: { launcherWarnings: () => [], answeredPipeEvent: () => {} },
    verbCtx,
    draw: (...request: Parameters<DaemonParts["draw"]>) => drawAnswer(parts, ...request),
    get frameFeeds() {
      if (feeds === null) throw new Error("a draw read the feed before it was built");
      return feeds;
    },
  } as unknown as DaemonParts;
  const passed = () => (_bar: Frame, json: string) => ({ json, value: null });
  feeds = new FrameFeeds<CheckedRenderRequest>({
    render: (sessionId, fps, at) => renderFrame(parts, sessionId, fps, at),
    watch: (sessionId, onChange) => reaction(() => sessionState.revision(sessionId), onChange),
    lanes: (sessionId) => viewLanes(parts, sessionId),
    pin: (sessionId) => cache.pin(sessionId),
    shown: () => true,
    watching: () => () => {},
    refreshes: () => new RefreshLedger().totals(),
    periods: FEED_PERIODS,
    encoders: { band: passed, statusline: passed, pane: passed, tmuxStatus: passed } as unknown as LaneEncoders,
    clock,
    instant: () => instantAt(clock),
    log: () => {},
  });
  const feed = feeds;
  cleanup(() => {
    feed.close();
    menuIdle.dispose();
    recorder.close();
    cache.close();
    runs.close();
    providers.gitProvider.close();
    providers.usageStore.close();
    providers.tmuxService.close();
    providers.managedStorage.close();
    providers.hostService.close();
    watchers.closeAll();
    turns.close();
    sessionState.close();
  });
  // Pushed after the teardown, so it runs ahead of it.
  cleanup(unlogged);

  // The client hints of a tick run in tmux pane `pane` by the process `pid`,
  // started when the stand-in Claude Code's record says.
  const hintsOf = (pid: number): ClientHints => ({
    termCols: 120,
    tmux: { socket: path.join(home, "tmux.sock"), pane, truecolor: null },
    parent: { pid, startTime: CLAUDE_START },
    claudeConfigDir,
  });
  // One statusline tick of `sid` from the process `pid`, as the daemon
  // replies to it: through the checkpoint, the arm's turn, and the draw, at
  // the clock's instant. Its client's deadline is that instant, so it leaves
  // no time to wait on its sources and the held clock never has to move.
  const tick = async (sid: string, pid: number): Promise<void> => {
    const { resp } = await replyTo(
      parts,
      {
        v: PROTOCOL_VERSION,
        kind: "render",
        encoding: "frame",
        deadline: clock.now(),
        ...renderBody(sid, home, hintsOf(pid), configFlag(configFile)),
      } as unknown as Parameters<typeof replyTo>[1],
      () => false,
      clock.monotonic(),
      () => false,
    );
    if (!resp.ok) throw new Error(`the tick drew no bar: ${JSON.stringify(resp)}`);
    unlogged();
  };
  // A session whose first tick from `pid` opened its view, recorded from
  // there on: each later tick returns the list its draw built.
  const opened = async (sid: string, pid: number) => {
    await tick(sid, pid);
    const written: RecordingLine[] = [];
    const stop = recorder.record(sessionIdOf(sid), {
      write: (line) => void written.push(line),
      end: () => {},
    });
    cleanup(stop);
    return {
      tick: async (): Promise<DiagnosticList> => {
        const before = written.length;
        await tick(sid, pid);
        const draws = written.slice(before).flatMap((line) => (line.kind === "draw" ? [line] : []));
        if (draws.length !== 1) throw new Error(`the tick drew ${draws.length} recorded answers`);
        return draws[0]!.diagnostics;
      },
    };
  };
  return {
    clock,
    opened,
    // The stand-in Claude Code at `pid` holds `sid` now: a `/clear` when
    // written again.
    holds: (pid: number, sid: string) => claudeHolds(claudeConfigDir, pid, sid),
    recordAt: (pid: number) => path.join(claudeConfigDir, "sessions", `${pid}.json`),
  };
}
