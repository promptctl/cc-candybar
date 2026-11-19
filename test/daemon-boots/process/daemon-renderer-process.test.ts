// [LAW:verifiable-goals] On a REAL daemon: the renderer runs in a process of
// its own, a renderer that dies is started again, and the bar the next one
// draws says the restart happened and what it cost.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf } from "../../../src/render/frame";
import { effectsOf, linksOf } from "../../../src/click/read";
import {
  effectsUrl,
  VERB_OPEN_VSCODE,
  VERB_RUN,
  VERB_SET_STATE,
} from "../../../src/click/wire";
import {
  RENDERER_WIRE_VERSION,
  type HostLine,
  type RendererLine,
} from "../../../src/renderer-interface/wire";
import type { Event, RequestId } from "../../../src/renderer-interface/interface";
import { EMPTY_STORED_STATE } from "../../../src/renderer-interface/stored-state";
import { MAIN_RENDERER } from "../../../src/daemon/foundations/renderer-name";
import { processRenderer, type RendererLink } from "../../../src/daemon/renderer-process";
import { RendererDown } from "../../../src/daemon/foundations/verb-error";
import { systemLauncher } from "../../../src/proc/system-launcher";
import { systemTimekeeper } from "../../../src/time";
import { sessionIdOf } from "../../../src/daemon/foundations/session-id";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSE,
} from "../../../src/config/disclosure";
import {
  click,
  drawnLink,
  hookData,
  observePane,
  render,
  renderBody,
  renderRequest,
  renderUntil,
  refusedClick,
  runRealClient,
  urlsOfAnsi,
} from "../../helpers/daemon-e2e";
import {
  spawnIsolatedDaemon,
  type IsolatedDaemonHandle,
} from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";
import {
  oversizedRendererHistory,
  oversizedSession,
} from "../../helpers/oversized-renderer-history";
import type { Instant, Tick } from "../../../src/utils/instant";
import { fieldsOf } from "../../../src/utils/logfmt";
import { heardRequest } from "../../helpers/click";

jest.setTimeout(30_000);

const COMPATIBLE_BOOT = {
  wireVersion: RENDERER_WIRE_VERSION,
  boot: {
    stored: EMPTY_STORED_STATE,
    locations: {
      home: "/home",
      configHome: "/home/.config",
      dataHome: "/home/.local/share",
      dataDirs: [],
    },
    memoryLimitBytes: 1,
  },
} satisfies Omit<Extract<HostLine, { kind: "boot" }>, "kind">;

function bootChild(...lines: readonly object[]) {
  return runRealClient(
    ["renderer"],
    {
      cwd: process.cwd(),
      env: process.env,
      input: lines
        .map((line) => `${JSON.stringify({ kind: "boot", ...line })}\n`)
        .join(""),
    },
    1,
  );
}

describe("the renderer wire handshake", () => {
  test.each([
    ["no version", {}, "no version"],
    [
      "a previous worktree build",
      { wireVersion: RENDERER_WIRE_VERSION - 1 },
      `version ${RENDERER_WIRE_VERSION - 1}`,
    ],
    [
      "a different version",
      { wireVersion: RENDERER_WIRE_VERSION + 1 },
      `version ${RENDERER_WIRE_VERSION + 1}`,
    ],
  ])(
    "the built child refuses %s before reading its boot payload",
    (_name, version, sent) => {
      // Only an old digest is present. It cannot be accepted as a boot.
      const child = bootChild(
        { ...version, boot: { digest: "old-build" } },
        COMPATIBLE_BOOT,
      );
      expect(child.status).toBe(1);
      expect(JSON.parse(child.stdout)).toMatchObject({
        kind: "refused",
        failure: {
          message: `renderer wire version mismatch (host sent ${sent}, expected version ${RENDERER_WIRE_VERSION})`,
        },
      });
    },
  );

  test("the built child starts with a matching version and resolved inputs", () => {
    const child = bootChild(COMPATIBLE_BOOT);
    expect(child.status).toBe(0);
    expect(
      child.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toContainEqual(
      expect.objectContaining({
        kind: "started",
        wireVersion: RENDERER_WIRE_VERSION,
      }),
    );
  });

  test("the packaged renderer boots without discovering the process's home or temp directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-renderer-boot-"));
    try {
      const probe = path.join(dir, "refuse-host.cjs");
      fs.writeFileSync(
        probe,
        `const os = require("node:os");
for (const name of ["homedir", "tmpdir"]) {
  os[name] = () => { throw new Error("renderer bootstrap read os." + name); };
}
require("node:module").syncBuiltinESMExports();`,
      );
      // [LAW:behavior-not-structure] The real CLI entry can start from its
      // boot message alone while process-level location reads are refused.
      const child = spawnSync(
        process.execPath,
        ["--require", probe, path.resolve("dist/index.mjs"), "renderer"],
        {
          encoding: "utf8",
          timeout: 10_000,
          input: `${JSON.stringify({ kind: "boot", ...COMPATIBLE_BOOT })}\n`,
        },
      );
      expect(child.stderr).toBe("");
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toMatchObject({
        kind: "started",
        wireVersion: RENDERER_WIRE_VERSION,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a matching version with no resolved locations refuses before readiness", () => {
    const child = bootChild({
      ...COMPATIBLE_BOOT,
      boot: { ...COMPATIBLE_BOOT.boot, locations: undefined },
    });
    expect(child.status).toBe(1);
    expect(JSON.parse(child.stdout)).toMatchObject({
      kind: "refused",
      failure: {
        kind: "threw",
        message: "renderer boot has no resolved locations",
        detail: "Error: renderer boot has no resolved locations",
      },
    });
  });

  test("a built child reports history trimmed at boot on readiness alone", () => {
    const child = bootChild(
      {
        ...COMPATIBLE_BOOT,
        boot: { ...COMPATIBLE_BOOT.boot, stored: oversizedRendererHistory() },
      },
      {
        kind: "input",
        n: 1,
        input: {
          kind: "event",
          at: 0 as Instant,
          tick: 0 as Tick,
          event: { kind: "start", viewers: {}, sessions: [], configs: [] },
        },
      } satisfies HostLine,
    );
    expect(child.status).toBe(0);
    const lines = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      expect.objectContaining({
        kind: "started",
        diagnostics: [
          {
            level: "info",
            line: `settings-history: trimmed an old step for session ${oversizedSession}`,
          },
        ],
      }),
      expect.objectContaining({
        kind: "output",
        n: 1,
        output: expect.objectContaining({
          kind: "answered",
          stored: [
            { store: "settings-history", key: oversizedSession, value: null },
          ],
        }),
      }),
    ]);
    expect(lines[1]?.output).not.toHaveProperty("diagnostics");
  });
});

test("a built renderer answers command and draw events on the same numbered stream", () => {
  const events: readonly Event[] = [
    { kind: "start", viewers: {}, sessions: [], configs: [] },
    { kind: "stats" },
    { kind: "due" },
    { kind: "debug", what: "config" },
    { kind: "close-journal" },
    { kind: "close-views" },
  ];
  const lines: HostLine[] = events.map((event, index) => ({
    kind: "input",
    n: index + 1,
    input: { kind: "event", at: 0 as Instant, tick: 0 as Tick, event },
  }));
  const child = bootChild(COMPATIBLE_BOOT, ...lines);
  expect(child.status).toBe(0);
  const output = child.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RendererLine);
  expect(output.map((line) => line.kind)).toEqual([
    "started",
    ...events.map(() => "output"),
  ]);
  const answers = output.flatMap((line) =>
    line.kind === "output" ? [line] : [],
  );
  expect(answers.map(({ n, output }) => [n, output.kind])).toEqual(
    events.map((_, index) => [index + 1, "answered"]),
  );
  expect(
    answers.map(({ output }) =>
      output.kind === "answered" ? output.reply : undefined,
    ),
  ).toEqual([
    undefined,
    {
      kind: "stats",
      stats: expect.objectContaining({
        framesDrawn: 0,
        rendererTurns: { parked: 0, presents: 0, deferrals: 0 },
      }),
    },
    undefined,
    { kind: "debug", snapshot: { what: "config", config: null } },
    { kind: "close-journal" },
    { kind: "close-views" },
  ]);
});

test("the same failed turn returns identical data from different worker paths", () => {
  const relocated = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-replay-worker-"));
  try {
    const built = path.resolve("dist/index.mjs");
    const second = path.join(relocated, "index.mjs");
    // A relocated entry with a different source line offset runs the same code.
    const source = fs.readFileSync(built, "utf8");
    expect(source.startsWith("#!")).toBe(true);
    fs.writeFileSync(second, source.replace("\n", "\n\n"));
    const answer = (bundle: string, session: string) => {
      const lines: readonly HostLine[] = [
        { kind: "boot", ...COMPATIBLE_BOOT },
        {
          kind: "input",
          n: 1,
          input: {
            kind: "event",
            at: 0 as Instant,
            tick: 0 as Tick,
            event: {
              kind: "request",
              id: 1 as RequestId,
              context: heardRequest(session),
            },
          },
        },
      ];
      const result = spawnSync(process.execPath, [bundle, "renderer"], {
        encoding: "utf8",
        env: {},
        timeout: 10_000,
        input: lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const [started, reply] = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as RendererLine);
      expect(started?.kind).toBe("started");
      if (reply?.kind !== "output" || reply.output.kind !== "threw")
        throw new Error(
          `the worker did not answer its missing context: ${result.stdout}`,
        );
      // Transport time records each execution. Replay compares the answer
      // itself, including its complete failure and diagnostics.
      const { turnMs: _elapsed, ...output } = reply.output;
      return output;
    };

    const first = answer(built, "missing-context");
    expect(first.failure.message).toContain('"missing-context"');
    expect(JSON.stringify(answer(second, "missing-context"))).toBe(
      JSON.stringify(first),
    );
    const different = answer(second, "another-context");
    expect(different.failure.message).toContain('"another-context"');
    expect(different.failure.detail).not.toBe(first.failure.detail);
  } finally {
    fs.rmSync(relocated, { recursive: true, force: true });
  }
});

test("the supervisor names the unanswered input when its built worker is killed", async () => {
  const cancel = new AbortController();
  const launcher = systemLauncher(
    { inherited: process.env, signal: cancel.signal },
    systemTimekeeper,
  );
  const ready = Promise.withResolvers<void>();
  const sent = Promise.withResolvers<number>();
  const logged: string[] = [];
  const session = sessionIdOf("interrupted-session");
  const readings = { at: 0 as Instant, tick: 0 as Tick };
  const link: RendererLink = processRenderer({
    launcher: {
      launchChannel: (options) => {
        const channel = launcher.launchChannel(options);
        return {
          ...channel,
          write: (text) => {
            channel.write(text);
            const line = JSON.parse(text) as HostLine;
            if (
              line.kind === "input" &&
              line.input.kind === "event" &&
              line.input.event.kind === "retire" &&
              line.input.event.session === session
            )
              sent.resolve(line.n);
          },
        };
      },
    },
    clock: systemTimekeeper,
    name: MAIN_RENDERER,
    entry: path.join(process.cwd(), "dist", "index.mjs"),
    cwd: process.cwd(),
    heapCapMb: 256,
    node: [process.execPath],
    boot: () => COMPATIBLE_BOOT.boot,
    log: (_level, line) => void logged.push(line),
    ended: (event) => ready.reject(new Error(event.text)),
    start: async () => {
      const answer = await link.renderer.answer({
        kind: "event",
        ...readings,
        event: { kind: "start", sessions: [], viewers: {}, configs: [] },
      });
      if (answer.kind !== "answered") throw new Error(answer.failure.detail);
      ready.resolve();
    },
  });
  try {
    link.arm();
    await ready.promise;
    const child = link.process();
    if (child === null) throw new Error("renderer lost after its START");
    process.kill(child.pid, "SIGSTOP");
    const unanswered = expect(
      link.renderer.answer({
        kind: "event",
        ...readings,
        event: { kind: "retire", session },
      }),
    ).rejects.toThrow(RendererDown);
    const n = await sent.promise;
    process.kill(child.pid, "SIGKILL");
    await unanswered;
    const interrupted = logged.filter((line) =>
      line.startsWith("renderer input interrupted "),
    );
    expect(interrupted).toHaveLength(1);
    expect(Object.fromEntries(fieldsOf(interrupted[0]!))).toEqual({
      renderer: MAIN_RENDERER,
      generation: "1",
      wire: String(n),
      input: "retire",
      sid: session,
      error: "killed by SIGKILL",
    });
  } finally {
    await link.close();
    cancel.abort();
    await launcher.settled();
  }
});

// Every renderer start the daemon logged, by pid, in order.
function rendererStarts(handle: IsolatedDaemonHandle): number[] {
  const log = fs.readFileSync(path.join(handle.stateDir, "daemon.log"), "utf8");
  return [...log.matchAll(/renderer main\[\d+\] started pid=(\d+)/g)].map((m) =>
    Number(m[1]),
  );
}

describe("the daemon's renderer process", () => {
  let handle: IsolatedDaemonHandle;
  let projectDir: string;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-rproc-"));
    handle = await spawnIsolatedDaemon("cc-candybar-rproc");
  });

  afterEach(async () => {
    await handle.cleanup();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test("draws the bar from its own process, and one killed is restarted with the bar saying so", async () => {
    const first = await render(handle.sockPath, "rproc", projectDir);
    expect(textOf(first).length).toBeGreaterThan(0);
    // Nothing is wrong before the end, so the warning that follows is its.
    expect(textOf(first)).not.toMatch(/⚠/);
    const [pid] = rendererStarts(handle);
    expect(pid).toBeDefined();
    expect(pid).not.toBe(handle.child.pid);

    const profileConfig = path.join(projectDir, "profile.json5");
    fs.writeFileSync(
      profileConfig,
      JSON.stringify({
        segments: { choice: { template: "profile-body" } },
        root: {
          h: [
            {
              kind: "group",
              name: "details",
              label: "details",
              open: true,
              children: ["choice"],
            },
          ],
        },
      }),
    );
    const profileSession = "rproc-profile";
    const drawProfile = () =>
      render(handle.sockPath, profileSession, projectDir, {}, [
        "cc-candybar",
        "--config-only",
        profileConfig,
      ]);
    const opened = await drawProfile();
    expect(textOf(opened)).toContain("profile-body");
    const close = linksOf(opened).find(({ url }) =>
      effectsOf(url).some(
        ({ verb, args }) =>
          verb === VERB_SET_STATE &&
          args[0] === profileSession &&
          args[2] === DISCLOSURE_CLOSED,
      ),
    );
    if (!close) throw new Error("the profile fixture drew no close action");
    await click(handle.sockPath, close.url);
    expect(textOf(await drawProfile())).not.toContain("profile-body");

    process.kill(pid!, "SIGKILL");
    await until(
      () => rendererStarts(handle).length === 2,
      () => "the renderer to be started again",
      10_000,
    );
    expect(rendererStarts(handle)[1]).not.toBe(pid);
    const restored = textOf(await drawProfile());
    expect(restored).toContain("details");
    expect(restored).not.toContain("profile-body");

    // The restarted renderer configures the session again from the request
    // the daemon holds, and the bar warns of the end.
    const warned = await renderUntil(
      handle.sockPath,
      "rproc",
      projectDir,
      (frame) => /⚠/.test(textOf(frame)),
      "a bar warning that its renderer restarted",
      10_000,
    );
    expect(textOf(warned)).toMatch(/⚠ \d/);
    const log = fs.readFileSync(
      path.join(handle.stateDir, "daemon.log"),
      "utf8",
    );
    expect(log).toMatch(
      /renderer main\[1\] killed by SIGKILL after \d+ s; next start in 1 s/,
    );
    const profileLoads = log
      .split("\n")
      .filter(
        (line) =>
          line.includes(" config loaded ") &&
          line.includes(`files=${profileConfig} `),
      );
    expect(profileLoads).toHaveLength(2);
    expect(log.indexOf(profileLoads[0]!)).toBeLessThan(
      log.indexOf("renderer main[1] killed by SIGKILL"),
    );
    expect(log.indexOf(profileLoads[1]!)).toBeGreaterThan(
      log.indexOf("renderer main[2] started pid="),
    );
  });

  test("publishes identical clickable addresses for a request and the tmux pane feed", async () => {
    const external = "https://example.test/page#section";
    const authored = "cc-candybar://open-vscode/fixture";
    const config = path.join(projectDir, "links.json5");
    fs.writeFileSync(
      config,
      `{
      globals: { experimentalPane: true },
      segments: {
        body: { template: 'DISCLOSURE-BODY' },
        external: { template: '{{ link "${external}" "external" }}' },
        authored: { template: '{{ link "${authored}" "authored" }}' },
      },
      root: { h: [
        { kind: 'group', name: 'details', label: 'details', open: true, children: ['body'] },
        'external',
        'authored',
      ] },
    }`,
    );
    const session = "rproc-links";
    const args = ["cc-candybar", "--config", config];
    const request = await render(
      handle.sockPath,
      session,
      projectDir,
      {},
      args,
    );
    expect(linksOf(request)).toContainEqual({
      url: external,
      text: "external",
    });
    const requestLink = linksOf(request).find(
      ({ text }) => text === DISCLOSURE_GLYPH_CLOSE,
    )?.url;
    if (requestLink === undefined)
      throw new Error("request has no disclosure close");
    expect(textOf(request)).toContain("DISCLOSURE-BODY");
    expect(requestLink).toBe(drawnLink(handle.sockPath, requestLink, {
      renderer: MAIN_RENDERER,
      session: sessionIdOf(session),
    }));
    const authoredLink = linksOf(request).find(
      ({ text }) => text === "authored",
    )?.url;
    if (authoredLink === undefined) throw new Error("request has no authored link");
    expect(authoredLink).toBe(drawnLink(handle.sockPath, authored));
    expect(effectsOf(authoredLink)).toEqual([
      { verb: VERB_OPEN_VSCODE, args: ["fixture"] },
    ]);
    const ansi = await renderRequest(
      handle.sockPath,
      renderBody(session, projectDir, {}, args),
    );
    expect(urlsOfAnsi(ansi)).toEqual(
      expect.arrayContaining([requestLink, external, authoredLink]),
    );

    const pane = observePane(handle.sockPath, session);
    try {
      const frame = await pane.waitFor(
        (text) => text.includes("DISCLOSURE-BODY"),
        "the pane's first frame",
      );
      const urls = urlsOfAnsi(frame);
      const paneLink = urls.find((url) => url === requestLink);
      if (paneLink === undefined)
        throw new Error("pane has no disclosure close");
      expect(urls).toContain(external);
      expect(urls).toContain(authoredLink);
      await click(handle.sockPath, paneLink);
      await pane.waitFor(
        (text) => !text.includes("DISCLOSURE-BODY"),
        "the pane after its click",
      );
    } finally {
      pane.close();
    }
  });

  test("a run from an earlier frame keeps its drawn arguments and environment", async () => {
    const config = path.join(projectDir, "run.json5");
    const record = path.join(projectDir, "observed.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        globals: { experimentalPane: true },
        variables: {
          shown: { kind: "input", path: "model.display_name", type: "string" },
        },
        actions: {
          remember: {
            run: [
              process.execPath,
              "-e",
              'require("node:fs").writeFileSync(process.argv[1], JSON.stringify([process.argv[2], process.env.DRAWN]))',
              record,
              "{{ .shown }}",
            ],
            env: { DRAWN: "{{ .shown }}" },
          },
        },
        segments: { saved: { template: '{{ action "remember" .shown }}' } },
        root: { h: ["saved"] },
      }),
    );
    const session = "rproc-run";
    const args = ["cc-candybar", "--config", config];
    const draw = (value: string) =>
      renderRequest(handle.sockPath, {
        ...renderBody(session, projectDir, {}, args),
        hookData: {
          ...hookData(session, projectDir),
          model: { id: "fixture", display_name: value },
        },
      });
    const runUrl = (output: string): string => {
      const url = urlsOfAnsi(output).find((url) =>
        effectsOf(url).some(({ verb }) => verb === VERB_RUN),
      );
      if (url === undefined) throw new Error("frame has no run");
      return url;
    };
    const statuslineUrl = runUrl(await draw("first value"));

    const pane = observePane(handle.sockPath, session);
    const paneShowing = (text: string) =>
      pane.waitFor((plain) => plain.includes(text), `pane showing ${text}`);
    try {
      const paneUrl = runUrl(await paneShowing("first value"));
      expect(paneUrl).toBe(statuslineUrl);

      // The request carries the new input while the active pane draws the bar.
      await draw("second value");
      expect(runUrl(await paneShowing("second value"))).not.toBe(paneUrl);
      const displayed = effectsOf(statuslineUrl).find(
        ({ verb }) => verb === VERB_RUN,
      );
      if (displayed === undefined) throw new Error("missing displayed run");
      const outerOnly = drawnLink(
        handle.sockPath,
        effectsUrl([{ verb: VERB_RUN, args: displayed.args.slice(0, 3) }]),
      );
      await refusedClick(handle.sockPath, outerOnly, "bad-request");
      expect(fs.existsSync(record)).toBe(false);

      const wanted = JSON.stringify(["first value", "first value"]);
      for (const [surface, url] of [
        ["statusline", statuslineUrl],
        ["pane", paneUrl],
      ] as const) {
        await click(handle.sockPath, url);
        await until(
          () =>
            fs.existsSync(record) && fs.readFileSync(record, "utf8") === wanted,
          `the run's captured argv and env from the ${surface}`,
        );
        fs.unlinkSync(record);
      }
    } finally {
      pane.close();
    }
  });

  test("a renderer outlives no daemon, even one killed with no cleanup", async () => {
    await render(handle.sockPath, "rproc", projectDir);
    const [pid] = rendererStarts(handle);
    const alive = (): boolean => {
      try {
        process.kill(pid!, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    // The renderer is launched detached and leads a group of its own, so no
    // signal to the daemon's group reaches it; its end here can only be the
    // daemon's lifeline. The renderer's parent is the process the test holds,
    // so that pid is the daemon's own.
    const parent = Number(
      spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
      }).stdout.trim(),
    );
    expect(parent).toBe(handle.child.pid);
    process.kill(parent, "SIGKILL");
    await until(
      () => !alive(),
      () => `renderer ${pid} to end with its daemon`,
      10_000,
    );
  });
});
