// [LAW:verifiable-goals] The daemon as a value, in this jest worker with no
// process of its own: built from its inputs, driven by the request handling
// the socket uses, closed with nothing left running, and built again over the
// same storage to see a restart.

import {
  reportingClock,
  type ReportingClock,
} from "../../../src/daemon/task-throws";
import { linkKeyFile, linkKeyFromFile } from "../../../src/daemon/link-key";
import { linkSignerOver, type FrameSource } from "../../../src/click/link-signer";
import { createHook } from "node:async_hooks";
import { hostOf } from "../../../scripts/lib/host";
import type { Host } from "../../../src/host";
import type { ClaudeInputEdge } from "../../../src/claude-input/typing";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  effectsUrl,
  VERB_SET_STATE,
  VERB_SLASH,
} from "../../../src/click/wire";
import type { RenderOrigin } from "../../../src/config-hint";
import type { DaemonInputs, ServedDaemon } from "../../../src/daemon/daemon";
import { inProcessRenderer } from "../../../src/in-process-renderer";
import {
  processPort,
  type RendererPort,
} from "../../../src/daemon/renderer-process";
import {
  MAIN_RENDERER,
  rendererNameOf,
  type RendererName,
} from "../../../src/daemon/foundations/renderer-name";
import { type RendererBoot } from "../../../src/renderer-interface/interface";
import { OWNER_CONTEXT, type LaunchResult } from "../../../src/proc/launcher.js";
import { type Timekeeper } from "../../../src/time";
import { daemonClock } from "../../../src/host";
import { systemTimekeeper } from "../../../scripts/lib/system-clock";
import { createLauncher, LIFELINE_PROGRAM } from "../../../src/proc/launch";
import { fakeSpawner, hangs, readsStdin, shell } from "../../../src/proc/spawner-fake";
import { processProbe } from "../../helpers/host";
import {
  daemonPaths,
  settingsHistoryPath,
} from "../../../src/daemon/paths";
import {
  classifyInbound,
  PROTOCOL_VERSION,
  type ReaderRenderRequest,
  type Response,
} from "../../../src/daemon/foundations/protocol";
import { parseFrame, textOf, type Frame } from "../../../src/render/frame";
import { PACKAGE_VERSION } from "../../../src/version";
import { clickBody } from "../../../scripts/lib/daemon/requests";
import { findUrl, hookData } from "../../helpers/daemon-e2e";
import { linkUrls } from "../../helpers/frame";
import {
  buildDaemon,
  bundleAt,
  frameOf,
  prepareDaemon,
  replyOf,
  statsOf,
} from "../../helpers/in-worker-daemon";
import type { DaemonLog } from "../../../src/daemon/log";
import { sessionIdOf } from "../../../src/daemon/foundations/session-id";
import { plainEnvironment } from "../../../src/daemon/foundations/session-env";
import { heldClock } from "../../helpers/held-clock";
import type { FetchPricing } from "../../../src/daemon/cache/pricing";
import { ok } from "../../../src/utils/outcome";

const VALUE_REFUSED = sessionIdOf("value-refused");
const WORKTREE = rendererNameOf("worktree");

// The daemon and its process supervisor are real. The channel keeps one
// renderer boot waiting for the child, with end and crash under the test's clock.
function waitingRenderer(waitingFor: RendererName) {
  const launches: Array<(result: LaunchResult) => void> = [];
  const commands: Array<[RendererName, string]> = [];
  const closed: RendererName[] = [];
  const supervised = processPort({
    cwd: "/",
    heapCapMb: 64,
    launcher: {
      launchChannel: () => {
        let end!: (result: LaunchResult) => void;
        const ended = new Promise<LaunchResult>((resolve) => {
          end = resolve;
        });
        launches.push(end);
        return {
          pid: 9001,
          write: () => {},
          end: () => end({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
          ended,
        };
      },
    },
  });
  const local = inProcessRenderer();
  const port: RendererPort = (prepared) => {
    const chosen = prepared.name === waitingFor ? supervised : local;
    return {
      start: (own) => {
        const link = chosen(prepared).start(own);
        return {
          ...link,
          renderer: {
            answer: (input) => {
              const { kind } = input.event;
              if (kind === "close-journal" || kind === "close-views")
                commands.push([prepared.name, kind]);
              return link.renderer.answer(input);
            },
          },
          close: async () => {
            await link.close();
            closed.push(prepared.name);
          },
        };
      },
    };
  };
  return { port, launches, commands, closed };
}

jest.setTimeout(30_000);

describe("the daemon is a value", () => {
  let root: string;
  let projectDir: string;
  let config: string;
  let open: ServedDaemon | null = null;
  // Every log the case opened: a case that builds a second daemon ends both.
  const openLogs: DaemonLog[] = [];

  // The machine a case runs on, read when asked: the worker's environment as it
  // stands (a case may have put a stub on PATH), with its state under `root`.
  const hostNow = (): Host =>
    hostOf(
      {
        ...process.env,
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
      },
      { home: root },
    );
  // A link as this test's daemon draws it: signed with the key in its state
  // directory.
  const drawnHere = (link: string, source?: FrameSource): string =>
    linkSignerOver(
      linkKeyFromFile(linkKeyFile(daemonPaths(hostNow()).state)),
    ).signLink(link, source);

  const construct = (
    inputs: {
      clock?: ReportingClock;
      checkout?: string;
      digest?: string;
      sessionStores?: DaemonInputs["sessionStores"];
      renderer?: RendererPort;
      claudeInput?: () => ClaudeInputEdge;
      fetchPricing?: FetchPricing;
      launcher?: DaemonInputs["launcher"];
    } = {},
  ): ServedDaemon => {
    const { daemon, daemonLog } = buildDaemon({
      host: hostNow(),
      paths: daemonPaths(hostNow()),
      bundle: bundleAt(
        inputs.checkout ?? path.join(root, "checkout"),
        inputs.digest,
      ),
      ...(inputs.clock && { clock: inputs.clock }),
      ...(inputs.sessionStores && { sessionStores: inputs.sessionStores }),
      ...(inputs.renderer && { renderer: inputs.renderer }),
      ...(inputs.claudeInput && { claudeInput: inputs.claudeInput }),
      ...(inputs.fetchPricing && { fetchPricing: inputs.fetchPricing }),
      ...(inputs.launcher && { launcher: inputs.launcher }),
    });
    open = daemon;
    openLogs.push(daemonLog);
    return daemon;
  };

  const close = async (daemon: ServedDaemon): Promise<void> => {
    await (
      await daemon.close()
    ).settled;
    open = null;
  };

  // [LAW:one-source-of-truth] These clients take replies directly. A case
  // that states a deadline uses the wall clock of the daemon it drives.
  const renderRequest = (
    sessionId: string,
    deadline?: number,
  ): ReaderRenderRequest => ({
    v: PROTOCOL_VERSION,
    kind: "render",
    encoding: "frame",
    hookData: hookData(sessionId, projectDir),
    args: ["cc-candybar", "--config", config],
    cwd: projectDir,
    termCols: 200,
    termRows: 40,
    ...(deadline === undefined ? {} : { deadline }),
    // The environment it runs in now, as a client started by Claude Code
    // reports its own.
    env: plainEnvironment(process.env),
  });

  const worktreeRequest = (session: string): ReaderRenderRequest => ({
    ...renderRequest(session),
    env: plainEnvironment({ ...process.env, CC_CANDYBAR_NAME: WORKTREE }),
    client: {
      kind: "node",
      bundle: path.join(root, "checkout", "dist", "index.mjs"),
      source: null,
    },
  });

  const clickLink = (daemon: ServedDaemon, url: string): Promise<Response> =>
    replyOf(daemon, clickBody(url));

  const writeConfig = (text: string): void => writeFileSync(config, text);

  test("the daemon boots a renderer with resolved locations and no environment map", async () => {
    const host = hostOf(
      {
        XDG_CONFIG_HOME: path.join(root, "chosen-config"),
        XDG_DATA_HOME: path.join(root, "chosen-data"),
        XDG_DATA_DIRS: [
          path.join(root, "site-one"),
          path.join(root, "site-two"),
        ].join(":"),
        XDG_STATE_HOME: path.join(root, "state"),
        CANDYBAR_FIXTURE_PRIVATE: "boot-marker",
      },
      { home: root },
    );
    const boots: RendererBoot[] = [];
    const local = inProcessRenderer();
    const built = buildDaemon({
      host,
      paths: daemonPaths(host),
      renderer: (prepared) =>
        local({
          ...prepared,
          boot: () => {
            const boot = prepared.boot();
            boots.push(boot);
            return boot;
          },
        }),
    });
    open = built.daemon;
    openLogs.push(built.daemonLog);
    expect(boots.map((boot) => Object.keys(boot).sort())).toEqual([
      ["locations", "memoryLimitBytes", "region", "sessionRevision", "stored"],
    ]);
    expect(boots).toMatchObject([
      {
        sessionRevision: 0,
        locations: {
          home: root,
          configHome: path.join(root, "chosen-config"),
          dataHome: path.join(root, "chosen-data"),
          dataDirs: [path.join(root, "site-one"), path.join(root, "site-two")],
        },
      },
    ]);
    expect(JSON.stringify(boots)).not.toContain("boot-marker");
  });

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-value-"));
    // A source checkout: what the band's setup needs of the bundle it runs.
    const checkout = path.join(root, "checkout");
    mkdirSync(path.join(checkout, "dist"), { recursive: true });
    mkdirSync(path.join(checkout, "src"));
    mkdirSync(path.join(checkout, "bin"));
    writeFileSync(path.join(checkout, "dist", "index.mjs"), "");
    writeFileSync(path.join(checkout, "bin", "cc-candybar-native"), "");
    projectDir = path.join(root, "project");
    mkdirSync(projectDir);
    config = path.join(projectDir, "bar.json5");
  });

  afterEach(async () => {
    if (open !== null) await close(open);
    for (const log of openLogs.splice(0)) {
      await log.drained();
      log.dispose();
    }
    // A live scope would refuse the next test's daemon; this file runs one at a
    // time, so what is left here is the case's own.
    rmSync(daemonPaths(hostNow()).state, { recursive: true, force: true });
    // A case's daemon that priced an entry left a fresh table here, which the
    // next case's would read in place of its own fetch.
    rmSync(daemonPaths(hostNow()).pricingCache, { force: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const PADDED = `{
    actions: { wide: { set: "padding", to: "4" } },
    segments: {
      pad: { template: '{{ action "wide" "[wide]" }}', bg: "surface", fg: "foreground" },
    },
    root: { h: ["pad"] },
  }`;
  const width = (bar: Frame): number => textOf(bar).trimEnd().length;

  test("only serving opens ingress, and a prepared daemon can close before it serves", async () => {
    const { daemon, daemonLog } = prepareDaemon({
      host: hostNow(),
      paths: daemonPaths(hostNow()),
    });
    openLogs.push(daemonLog);
    expect(daemon).not.toHaveProperty("handle");
    expect(daemon).not.toHaveProperty("reply");
    expect(daemon).not.toHaveProperty("subscribe");
    const closing = daemon.close();
    expect(daemon.close()).toBe(closing);
    expect(() => daemon.serve()).toThrow("the daemon closed");
    await expect((await closing).settled).resolves.toEqual({ unreaped: [] });
  });

  test("shutdown closes a primary still booting without requesting its journal or views", async () => {
    const renderer = waitingRenderer(MAIN_RENDERER);
    const daemon = construct({ renderer: renderer.port });
    daemon.arm();
    expect(renderer.launches).toHaveLength(1);

    await close(daemon);

    expect(renderer.commands).toEqual([]);
    expect(renderer.closed).toEqual([MAIN_RENDERER]);
    await Promise.all(openLogs.map((log) => log.drained()));
    const log = readFileSync(daemonPaths(hostNow()).log, "utf8");
    expect(log).toContain("renderer main[1] exited in the daemon's close");
    expect(log).not.toMatch(
      /main close-(journal|views) failed|renderer main\[1\] start failed/,
    );
  });

  test("shutdown drains a live primary and cancels the restart of a down named renderer", async () => {
    writeConfig(PADDED);
    const clock = heldClock(new Date(), reportingClock);
    const renderer = waitingRenderer(WORKTREE);
    const daemon = construct({ clock, renderer: renderer.port });
    daemon.arm();
    await frameOf(daemon, renderRequest("live-primary"));
    const requested = daemon.handle(
      classifyInbound(worktreeRequest("down-worktree")),
      () => false,
      daemon.stats.accept(),
      () => false,
    );
    expect(renderer.launches).toHaveLength(1);
    renderer.launches[0]!({
      ok: false,
      reason: "signal",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: "SIGTERM",
    });
    expect(await requested).toMatchObject({
      kind: "reply",
      resp: {
        ok: false,
        error: expect.stringContaining("renderer worktree is down"),
      },
    });

    await close(daemon);
    await clock.settle(60_000);

    expect(renderer.commands).toEqual([
      [MAIN_RENDERER, "close-journal"],
      [MAIN_RENDERER, "close-views"],
    ]);
    expect(renderer.closed).toEqual([MAIN_RENDERER, WORKTREE]);
    expect(renderer.launches).toHaveLength(1);
    await Promise.all(openLogs.map((log) => log.drained()));
    const log = readFileSync(daemonPaths(hostNow()).log, "utf8");
    expect(log).not.toMatch(/worktree close-(journal|views) failed/);
  });

  test("competing renderers admit the same session in order while an unrelated session can click on the waiting peer", async () => {
    writeConfig(PADDED);
    const shared = sessionIdOf("admitted-on-two-renderers");
    const other = sessionIdOf("independent-writer");
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const observed: string[] = [];
    const port: RendererPort = prepared => inProcessRenderer(core => ({
      answer: async input => {
        if (input.event.kind === "click") {
          const session = input.event.click.session;
          observed.push(prepared.name + "/" + session);
          if (prepared.name === MAIN_RENDERER && session === shared) {
            entered.resolve();
            await released.promise;
          }
        }
        return core.answer(input);
      },
    }))(prepared);
    const daemon = construct({ renderer: port });
    await frameOf(daemon, renderRequest(shared));
    await frameOf(daemon, worktreeRequest(shared));
    await frameOf(daemon, worktreeRequest(other));
    const write = (source: FrameSource, value: string) => clickLink(daemon, drawnHere(
      effectsUrl([{ verb: VERB_SET_STATE, args: [source.session, "padding", value] }]),
      source,
    ));
    const first = write({ renderer: MAIN_RENDERER, session: shared }, "3");
    await entered.promise;
    const second = write({ renderer: WORKTREE, session: shared }, "4");
    try {
      expect(await write({ renderer: WORKTREE, session: other }, "2")).toMatchObject({ ok: true });
      expect(observed).toEqual(["main/" + shared, "worktree/" + other]);
    } finally {
      released.resolve();
      expect(await Promise.all([first, second])).toEqual([
        expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true }),
      ]);
    }
    expect(observed.at(-1)).toBe("worktree/" + shared);
  });

  test("the drain refuses pending work while another renderer flushes its journal", async () => {
    const pause = () => {
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        reached,
        release,
        wait: () => {
          entered();
          return released;
        },
      };
    };
    const context = pause();
    const journal = pause();
    const firstAct = pause();
    let paneReads = 0;
    const linesTyped: string[] = [];
    const session = "render-during-drain";
    const local = inProcessRenderer();
    const port: RendererPort = (prepared) => ({
      start: (own) => {
        const link = local(prepared).start(own);
        return {
          ...link,
          renderer: {
            answer: async (input) => {
              if (
                input.event.kind === "context" &&
                input.event.context.hookData.session_id === session
              )
                await context.wait();
              if (
                prepared.name === WORKTREE &&
                input.event.kind === "close-journal"
              )
                await journal.wait();
              return link.renderer.answer(input);
            },
          },
        };
      },
    });
    writeConfig(`{
      actions: { compact: { slash: '/compact' }, clear: { slash: '/clear' } },
      segments: {
        commands: { template: '{{ action "compact" "compact" }} {{ action "clear" "clear" }}' },
      },
      root: { h: ['commands'] },
    }`);
    const daemon = construct({
      renderer: port,
      claudeInput: () => ({
        read: async () => {
          paneReads++;
          return {
            inMode: false,
            screen: ["─".repeat(30), "❯ ", "─".repeat(30)],
          };
        },
        type: async (_pane, line) => {
          linesTyped.push(line);
          if (line === "/compact") await firstAct.wait();
          return { kind: "typed" };
        },
      }),
    });
    await frameOf(daemon, worktreeRequest("worktree-drains"));
    const pane = await frameOf(daemon, {
      ...renderRequest("pane-during-drain"),
      tmux: {
        socket: path.join(root, "tmux.sock"),
        pane: "%7",
        truecolor: null,
      },
    });
    const slashLink = (line: string) =>
      findUrl(linkUrls(pane), (effects) =>
        effects.some(
          ({ verb, args }) => verb === VERB_SLASH && args[1] === line,
        ),
      );
    const compact = slashLink("/compact");
    const clear = slashLink("/clear");
    if (compact === undefined || clear === undefined)
      throw new Error("the pane actions did not draw their links");
    const request = (req: ReaderRenderRequest | ReturnType<typeof clickBody>) =>
      daemon.handle(
        classifyInbound(req),
        () => false,
        daemon.stats.accept(),
        () => false,
      );
    try {
      const first = request(clickBody(compact));
      await Promise.race([
        firstAct.reached,
        first.then((reply) => {
          throw new Error(
            `the first click did not type: ${JSON.stringify(reply)}`,
          );
        }),
      ]);
      const second = request(clickBody(clear));
      // The context uses the same mailbox. Once it reaches the renderer,
      // the second click has already handed its act to the pane queue.
      const pending = request(
        renderRequest(session, systemTimekeeper.now() + 20_000),
      );
      await context.reached;
      expect(linesTyped).toEqual(["/compact"]);
      void daemon.close();
      context.release();
      await journal.reached;
      const handled = await pending;
      if (handled.kind !== "reply") throw new Error("expected a render reply");
      handled.settled(true);
      expect(handled.resp).toMatchObject({
        ok: false,
        error: expect.stringContaining("the daemon closed"),
      });
      firstAct.release();
      for (const clicked of await Promise.all([first, second])) {
        if (clicked.kind !== "reply") throw new Error("expected a click reply");
        clicked.settled(true);
      }
      expect(paneReads).toBe(1);
      expect(linesTyped).toEqual(["/compact"]);
    } finally {
      firstAct.release();
      context.release();
      journal.release();
      await close(daemon);
    }
    await Promise.all(openLogs.map((log) => log.drained()));
    const log = readFileSync(daemonPaths(hostNow()).log, "utf8");
    expect(log).toMatch(
      /\[info\] render .*sid=render-during-drain .*outcome=closing/,
    );
    expect(log).toMatch(
      /\[info\] act kind=type-slash .*outcome=ok — \/compact: typed/,
    );
    expect(log).toMatch(
      /\[info\] act kind=type-slash .*outcome=closing — \/clear:/,
    );
  });

  test("closing refuses requests and subscriptions without throwing or writing a click", async () => {
    writeConfig(PADDED);
    const daemon = construct();
    await frameOf(daemon, renderRequest("value-refused"));
    const click = clickBody(
      drawnHere(
        effectsUrl([
          { verb: VERB_SET_STATE, args: ["value-refused", "a.key", "on"] },
        ]),
      ),
    );
    const closing = daemon.close();
    expect(daemon.close()).toBe(closing);
    const accepted = daemon.stats.accept();
    const render = await daemon.handle(
      classifyInbound(renderRequest("value-refused")),
      () => false,
      accepted,
      () => false,
    );
    expect(render).toMatchObject({
      kind: "reply",
      resp: {
        ok: false,
        error: "the daemon closed: render refused",
      },
    });
    const clicked = await daemon.reply(
      click,
      () => false,
      daemon.stats.accept(),
      () => false,
    );
    expect(clicked.resp).toMatchObject({
      ok: false,
      error: "the daemon closed: click refused",
    });
    const refused = jest.fn();
    const unsubscribe = daemon.subscribe(VALUE_REFUSED, {
      lane: "statusline",
      owner: null,
      frame: () => {},
      refused,
      drawing: () => true,
    });
    unsubscribe();
    expect(refused).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "the daemon closed: subscribe refused",
      }),
    );
    expect(() => daemon.arm()).toThrow("the daemon closed");
    await close(daemon);
    expect(existsSync(settingsHistoryPath(hostNow()))).toBe(false);
    await Promise.all(openLogs.map((log) => log.drained()));
    const lines = readFileSync(daemonPaths(hostNow()).log, "utf8").split("\n");
    const event = lines.filter((line) =>
      line.includes(` render req=${accepted.id} `),
    );
    expect(event).toHaveLength(1);
    expect(event[0]).toContain("[info]");
    expect(event[0]).toContain(" outcome=closing ");
  });

  // [LAW:no-shared-mutable-globals] What a daemon's loads accept is its own
  // value, so a second daemon built beside a live one is a daemon like any other.
  test("a second daemon beside a live one is built and answers", async () => {
    writeConfig(PADDED);
    const first = construct();
    const second = construct();
    expect(second).not.toBe(first);
    await frameOf(first, renderRequest("value-first"));
    await frameOf(second, renderRequest("value-second"));
    await close(first);
    await close(second);
  });

  test("a build that throws stands in the way of no next build", async () => {
    writeConfig(PADDED);
    const unreadable = (): never => {
      throw new Error("the profile cannot be opened");
    };
    const live = new Set<number>();
    const resources = createHook({
      init(id, type) {
        if (["Timeout", "FSEVENTWRAP", "FSEVENT", "PROCESSWRAP", "PIPEWRAP"].includes(type)) live.add(id);
      },
      destroy(id) { live.delete(id); },
    }).enable();
    try {
      expect(() => construct({ sessionStores: unreadable })).toThrow(
        "the profile cannot be opened",
      );
      expect([...live]).toEqual([]);
    } finally {
      resources.disable();
    }

    const daemon = construct();
    await frameOf(daemon, renderRequest("value-rebuilt"));
    await close(daemon);
  });

  test("a render and a click go through the socket's own request handling", async () => {
    writeConfig(PADDED);
    const daemon = construct();

    const before = await frameOf(daemon, renderRequest("value-click"));
    expect(textOf(before)).toContain("[wide]");
    const [url] = linkUrls(before);
    await clickLink(daemon, url!);

    const after = await frameOf(daemon, renderRequest("value-click"));
    expect(width(after)).toBeGreaterThan(width(before));
  });

  test("a second daemon over the same storage sees the first's picks", async () => {
    writeConfig(PADDED);
    const first = construct();
    const before = await frameOf(first, renderRequest("value-restart"));
    const [url] = linkUrls(before);
    await clickLink(first, url!);
    await close(first);

    const second = construct();
    const after = await frameOf(second, renderRequest("value-restart"));
    expect(width(after)).toBeGreaterThan(width(before));
  });

  test("the bundle it is given is the build its stats name", async () => {
    const daemon = construct({ digest: "the-given-digest" });
    expect((await statsOf(daemon)).sourceDigest).toBe("the-given-digest");
    await close(daemon);
  });

  // `cc-candybar ssh-config` names the forwarded socket by this id, and the URL
  // handler reads the same id from the links the daemon signs.
  test("the key id its stats name is the one its links carry", async () => {
    const daemon = construct();
    const { linkKeyId } = await statsOf(daemon);
    const link = drawnHere("cc-candybar://copy/x");
    expect(linkKeyId).toEqual({
      kind: "ok",
      value: link.slice(link.lastIndexOf("#") + 1).split("/")[0],
    });
    await close(daemon);
  });

  test("the clock it is given is the instant the bar is drawn at", async () => {
    writeConfig(
      `{ segments: { at: { template: 'EPOCH={{ unixEpoch now }}' } }, root: { h: ['at'] } }`,
    );
    const frozen = new Date("2031-02-03T04:05:06Z");
    const clock = { ...daemonClock(), now: () => frozen.getTime() };
    const daemon = construct({ clock });

    const bar = await frameOf(
      daemon,
      renderRequest("value-clock", clock.now() + 2_000),
    );
    expect(textOf(bar)).toContain(`EPOCH=${frozen.getTime() / 1000}`);
  });

  test("close reaps the launcher's live child and refuses a late launch", async () => {
    const daemon = construct();
    let ready!: () => void;
    const listening = new Promise<void>((resolve) => { ready = resolve; });
    const child = daemon.launcher.launchChannel({ ...OWNER_CONTEXT,
      bin: "/bin/sh", args: ["-c", "echo ready; exec cat"],
      category: "user-shell",
      heard: { stdout: ready, stderr: () => {} },
    });
    await Promise.race([listening, child.ended.then((r) => {
      throw new Error("child exited before readiness: " + JSON.stringify(r));
    })]);
    expect(child.pid).not.toBeNull();
    expect(processProbe.alive(child.pid!)).toBe(true);
    await close(daemon);
    expect(await child.ended).toMatchObject({ ok: false, reason: "aborted" });
    expect(processProbe.alive(child.pid!)).toBe(false);
    expect(await daemon.launcher.launch({ ...OWNER_CONTEXT, bin: "/bin/echo", category: "user-shell" }))
      .toMatchObject({ ok: false, reason: "aborted" });
  });

  test("closing an armed daemon aborts a subscribed shell source and its waiting render; reaping the child starts no work", async () => {
    const session = sessionIdOf("value-close");
    const command = "hold-source";
    writeConfig(`{
      globals: { experimentalStatusline: true },
      variables: { slow: { kind: 'shell', command: '${command}', parse: { json: true }, cache: { never: true } } },
      segments: { mark: { template: 'mark {{ .slow }}' } },
      root: { h: ['mark'] },
    }`);
    const start = new Date();
    const clock = heldClock(start, reportingClock);
    // The OS delivers child exit independently of the daemon's timer queue.
    const processes = heldClock(start);
    const spawner = fakeSpawner(processes);
    spawner.program(
      (bin, args) => bin === "awk" && args[0] === LIFELINE_PROGRAM,
      readsStdin("until-end"),
    );
    const source = shell(command);
    spawner.program(source, hangs());
    const waiting = Promise.withResolvers<void>();
    const daemon = construct({
      clock: {
        ...clock,
        after: (name, ms, fire, options) => {
          const stop = clock.after(name, ms, fire, options);
          if (name === `render wait ${session}`) waiting.resolve();
          return stop;
        },
      },
      launcher: (owner) => createLauncher(owner, clock, spawner),
    });
    daemon.arm();
    const frame = jest.fn();
    const refused = jest.fn();
    daemon.subscribe(session, {
      lane: "statusline",
      owner: null,
      frame,
      refused,
      drawing: () => true,
    });
    const render = daemon.handle(
      classifyInbound(renderRequest(session, clock.now() + 20_000)),
      () => false,
      daemon.stats.accept(),
      () => false,
    );
    await waiting.promise;
    const child = spawner.spawned.find(({ bin, args }) => source(bin, args));
    expect(child).toMatchObject({ ended: null, signals: [] });
    expect(refused).not.toHaveBeenCalled();
    const { settled } = await daemon.close();
    const atClose = clock.activity();
    const framesAtClose = frame.mock.calls.length;
    // SIGTERM has reached the OS. It will deliver the child's exit on its next turn.
    expect(child).toMatchObject({ ended: null, signals: ["SIGTERM"] });
    await processes.settle(0);
    expect(await settled).toEqual({ unreaped: [] });
    open = null;
    expect(child?.ended).toEqual({ code: null, signal: "SIGTERM" });
    expect(await render).toMatchObject({
      kind: "reply",
      resp: { ok: false, error: expect.stringContaining("the daemon closed") },
    });
    // Drain continuations of the source's late result. Even a timer that
    // armed and cleared in this turn would have advanced the activity record.
    await clock.settle(0);
    expect(clock.pending()).toBe(0);
    expect(clock.activity()).toEqual(atClose);
    expect(frame).toHaveBeenCalledTimes(framesAtClose);
    await Promise.all(openLogs.map((log) => log.drained()));
    const logged = readFileSync(daemonPaths(hostNow()).log, "utf8");
    expect(logged).toContain('feed sid="value-close" subscribed');
    expect(logged).toContain('feed sid="value-close" unwatched');
  });

  test("closing cancels an in-flight pricing fetch and discards its late response", async () => {
    writeConfig(`{
      segments: { mark: { template: 'priced {{ .session.cost }}' } },
      root: { h: ['mark'] },
    }`);
    // A usage entry with no cost, which the session's fold prices.
    writeFileSync(
      path.join(projectDir, "transcript.jsonl"),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        requestId: "req-priced",
        message: {
          id: "msg-priced",
          model: "claude-opus-4-8",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }) + "\n",
    );
    const clock = heldClock(new Date(), reportingClock);
    const fetchAsked = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<void>();
    const prices = readFileSync(
      path.resolve(__dirname, "../../../pricing.json"),
      "utf8",
    );
    const fetchPricing: FetchPricing = async (signal) => {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      fetchAsked.resolve();
      await reply.promise;
      return ok(prices);
    };
    const daemon = construct({ clock, fetchPricing });
    const render = daemon.handle(
      classifyInbound(renderRequest("value-pricing", clock.now() + 20_000)),
      () => false,
      daemon.stats.accept(),
      () => false,
    );
    await fetchAsked.promise;
    const closing = daemon.close();
    await aborted.promise;
    // The response crosses the cancellation, which must win even if the
    // remote operation was already too far along to cancel its result.
    reply.resolve();
    const { settled } = await closing;
    open = null;
    expect(await settled).toEqual({ unreaped: [] });
    await render;
    expect(clock.pending()).toBe(0);
    expect(existsSync(daemonPaths(hostNow()).pricingCache)).toBe(false);
  });
});
