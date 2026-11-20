// [LAW:verifiable-goals] A single real host launches two renderer entries,
// and observations of the same file stay at that host.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { decodeAnsi } from "@promptctl/rich-js";
import { textOf } from "../../../src/render/frame";
import { daemonArgs } from "../../../src/daemon/acquire";
import { openFrameStream } from "../../../src/daemon/client-frames";
import { PROTOCOL_VERSION } from "../../../src/daemon/foundations/protocol";
import { WORKTREE_MODEL } from "../../fixtures/named-renderer-payload";
import {
  click,
  findUrl,
  frameRequest,
  hookData,
  observePane,
  renderBody,
  renderRequest,
  urlsOfAnsi,
} from "../../helpers/daemon-e2e";
import { VERB_REPO_CONFIG, VERB_RUN, VERB_SET_STATE } from "../../../src/click/wire";
import { linksOf } from "../../../src/click/read";
import { DISCLOSURE_CLOSED } from "../../../src/config/disclosure";
import { sendDaemonRequest } from "../../helpers/daemon-wire";
import { until } from "../../helpers/until";
import { readProbe, readsOf, type Read } from "../../helpers/daemon-read-probe";
import { TEST_ENV } from "../../helpers/session-environment";
import { readDiagnostics } from "../../helpers/diagnostics-viewer";
import {
  repoConfigs,
  repoConfigsPath,
} from "../../../src/daemon/config-discovery/repo-configs";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  spawnIsolatedDaemon,
  type RunningDaemon,
} from "../../helpers/spawn-isolated-daemon";

const BUNDLE = path.resolve("dist/index.mjs");
const builtDaemon = (env: NodeJS.ProcessEnv) => ({
  bin: process.execPath,
  args: daemonArgs(BUNDLE, env),
});

let worktreeDir: string;
let worktreeBuilt: string;

beforeAll(() => {
  worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-alternate-renderer-"));
  worktreeBuilt = path.join(worktreeDir, "index.mjs");
  execFileSync(process.execPath, [path.resolve("test/helpers/build-named-renderer.mjs"), worktreeBuilt]);
});

afterAll(() => {
  fs.rmSync(worktreeDir, { recursive: true, force: true });
});

function cacheEntry(id: string, timestamp: string): string {
  return (
    JSON.stringify({
      type: "assistant",
      uuid: id,
      timestamp,
      message: {
        role: "assistant",
        content: [],
        usage: { cache_read_input_tokens: 10 },
      },
    }) + "\n"
  );
}

test("two named renderer processes draw separately and share config, transcript and plugin-source reads", async () => {
  const isolated = prepareIsolatedDaemonEnv("ccb-named");
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-named-fixture-")),
  );
  let daemon: RunningDaemon | undefined;
  const stopFeeds: (() => void)[] = [];
  try {
    const data = path.join(root, "data");
    const plugin = path.join(data, "cc-candybar", "plugins", "shared");
    fs.mkdirSync(plugin, { recursive: true });
    const source = path.join(plugin, "marker.txt");
    const definition = path.join(plugin, "plugin.json5");
    const packaged = path.join(root, "package-data");
    const shadowed = path.join(packaged, "cc-candybar", "plugins", "shared", "plugin.json5");
    fs.mkdirSync(path.dirname(shadowed), { recursive: true });
    fs.writeFileSync(shadowed, '{ segments: { marker: { template: "package copy" } } }');
    const config = path.join(root, "config.json5");
    const transcriptOf = (session: string) =>
      path.join(root, `${session}.jsonl`);
    const firstTranscript = transcriptOf("main-session");
    const secondTranscript = transcriptOf("secondary-session");
    const alternate = path.join(root, "worktree.mjs");
    const reads = path.join(root, "reads.jsonl");
    const probe = path.join(root, "reads.cjs");

    fs.writeFileSync(source, "one-shared-plugin-read\n");
    fs.writeFileSync(
      definition,
      `{
      variables: {
        marker: { kind: "file", path: ${JSON.stringify(source)}, cache: { watch_file: ${JSON.stringify(source)} } },
      },
      segments: { marker: { template: "{{ .plugins.shared.marker }}" } },
    }`,
    );
    fs.writeFileSync(
      config,
      `{
      globals: { experimentalStatusline: true, padding: 1 },
      actions: { wider: { persist: "padding", min: 0, max: 4, by: 1, layer: "user" } },
      variables: {
        modelName: { kind: "input", path: "model.display_name" },
        expiry: { kind: "input", path: "cache.expiresAt" },
      },
      segments: {
        model: { template: "{{ .modelName }}" },
        expiry: { template: "{{ if .expiry }}expiry={{ .expiry }}{{ end }}" },
        edit: { template: 'padding={{ .padding.effective }} {{ action "wider" "WIDER" }}' },
      },
      root: { h: ["model", "plugins.shared.marker", "expiry", "edit"] },
    }`,
    );
    for (const transcript of [firstTranscript, secondTranscript])
      fs.writeFileSync(
        transcript,
        cacheEntry("initial", "2026-11-19T12:00:00.000Z"),
      );
    fs.copyFileSync(worktreeBuilt, alternate);
    const shared = [config, definition, source];
    readProbe(probe, reads, {
      [config]: ["openSync", "payload"],
      [definition]: ["openSync", "payload"],
      [shadowed]: ["openSync", "payload"],
      [source]: ["readFile"],
      [firstTranscript]: ["open", "openSync"],
      [secondTranscript]: ["open", "openSync"],
    });
    daemon = await spawnDaemonWithEnv(
      {
        ...isolated.env,
        XDG_DATA_HOME: data,
        XDG_DATA_DIRS: packaged,
        NODE_OPTIONS: [isolated.env.NODE_OPTIONS, `--require=${probe}`]
          .filter(Boolean)
          .join(" "),
      },
      builtDaemon,
    );

    const args = ["cc-candybar", "--config", config];
    const request = (
      session: string,
      named?: { name: string; bundle: string },
      transcript = transcriptOf(session),
      configArgs = args,
    ) =>
      frameRequest(isolated.sockPath, {
        ...renderBody(session, root, {}, configArgs),
        hookData: {
          ...hookData(session, root),
          transcript_path: transcript,
        },
        ...(named !== undefined && {
          env: { ...TEST_ENV, CC_CANDYBAR_NAME: named.name },
          client: { kind: "node", bundle: named.bundle, source: null },
        }),
      });

    let primary = "";
    const expectedExpiry = (hour: string) =>
      `expiry=${Date.parse(`2026-11-19T${hour}:00:00.000Z`) / 1000}`;
    await until(
      async () => {
        primary = textOf(await request("main-session"));
        return (
          primary.includes("one-shared-plugin-read") &&
          primary.includes(expectedExpiry("13"))
        );
      },
      () => `primary plugin source was read, last frame: ${primary}`,
      8000,
    );
    expect(primary).toContain("Opus 4.7");
    expect(primary).not.toContain(WORKTREE_MODEL);
    const before = readsOf(reads);
    const count = (all: readonly Read[], file: string) =>
      all.filter((read) => read.file === file && read.operation !== "payload")
        .length;
    for (const file of shared) expect(count(before, file)).toBe(1);
    expect(count(before, firstTranscript)).toBeGreaterThan(0);
    expect(count(before, secondTranscript)).toBe(0);

    const selected = { name: "worktree", bundle: alternate };
    const push = spawn(
      process.execPath,
      [alternate, "frames", "--lane", "statusline", "--config", config],
      {
        cwd: root,
        env: { ...isolated.env, CC_CANDYBAR_NAME: selected.name },
        stdio: "pipe",
      },
    );
    const pushEnded = once(push, "exit");
    let pushed = "";
    let pushErrors = "";
    push.stdout.setEncoding("utf8").on("data", (text: string) => {
      pushed += text;
    });
    push.stderr.setEncoding("utf8").on("data", (text: string) => {
      pushErrors += text;
    });
    try {
      push.stdin.write(
        JSON.stringify({
          ...hookData("secondary-session", root),
          transcript_path: secondTranscript,
        }) + "\n",
      );
      await until(
        () =>
          pushed.includes(WORKTREE_MODEL) &&
          pushed.includes("one-shared-plugin-read"),
        () => `the named statusline feed: ${pushed || pushErrors}`,
        8000,
      );
    } finally {
      push.stdin.end();
      await pushEnded;
    }
    const worktree = textOf(await request("secondary-session", selected));
    expect(worktree).toContain(WORKTREE_MODEL);
    expect(worktree).toContain("one-shared-plugin-read");
    const stillPrimary = textOf(await request("main-session"));
    expect(stillPrimary).toContain("Opus 4.7");
    expect(stillPrimary).toContain("one-shared-plugin-read");
    expect(stillPrimary).not.toContain(WORKTREE_MODEL);
    const both = readsOf(reads);
    expect(both.filter((read) => read.file === shadowed)).toEqual([]);
    for (const file of shared) expect(count(both, file)).toBe(1);
    expect(count(both, firstTranscript)).toBe(count(before, firstTranscript));
    expect(count(both, secondTranscript)).toBeGreaterThan(0);

    // An existing Claude session can move to another renderer. Its
    // transcript and source keys stay held by the same host.
    expect(textOf(await request("main-session", selected))).toContain(
      WORKTREE_MODEL,
    );
    expect(textOf(await request("secondary-session", selected))).toContain(
      WORKTREE_MODEL,
    );
    expect(readsOf(reads)).toEqual(both);
    expect(new Set(both.map((read) => read.pid))).toEqual(
      new Set([daemon.child.pid]),
    );

    // A different Claude session, served by the worktree, names the same
    // transcript as the main process. Both consume the host's cache at the
    // current file version and again after an append.
    expect(textOf(await request("main-session"))).toContain("Opus 4.7");
    let alias = "";
    await until(
      async () => {
        alias = textOf(
          await request("alias-session", selected, firstTranscript),
        );
        return alias.includes(expectedExpiry("13"));
      },
      () => `the worktree showed no expiry for the shared transcript: ${alias}`,
      8000,
    );
    expect(alias).toContain(WORKTREE_MODEL);
    const beforeAppend = count(readsOf(reads), firstTranscript);
    expect(beforeAppend).toBe(count(both, firstTranscript));
    fs.appendFileSync(
      firstTranscript,
      cacheEntry("updated", "2026-11-19T14:00:00.000Z"),
    );
    await until(
      async () => {
        const [standard, alternative] = await Promise.all([
          request("main-session"),
          request("alias-session", selected, firstTranscript),
        ]);
        return [standard, alternative].every((frame) =>
          textOf(frame).includes(expectedExpiry("15")),
        );
      },
      () => "both renderers to observe the appended transcript entry",
      10_000,
    );
    expect(count(readsOf(reads), firstTranscript)).toBe(beforeAppend + 2);

    const follow = (session: string) => {
      const frames: string[] = [];
      const stream = openFrameStream(
        isolated.sockPath,
        session,
        "statusline",
        (frame) => {
          if (frame.ok && "output" in frame && typeof frame.output === "string")
            frames.push(decodeAnsi(frame.output).plain);
        },
        () => {},
      );
      stopFeeds.push(() => stream.close());
      return frames;
    };
    const standard = follow("main-session");
    const alternative = follow("secondary-session");
    const delivered = (contents: string) =>
      standard.some(
        (frame) => frame.includes("Opus 4.7") && frame.includes(contents),
      ) &&
      alternative.some(
        (frame) => frame.includes(WORKTREE_MODEL) && frame.includes(contents),
      );
    const updatedSource = "one-shared-plugin-refresh";
    await until(
      () => delivered("one-shared-plugin-read"),
      "both pushed frames",
    );
    const priorReads = count(readsOf(reads), source);
    fs.writeFileSync(source, `${updatedSource}\n`);
    // Both draw from the same file refresh, without another statusline
    // request re-admitting either renderer's subscriptions.
    await until(
      () => delivered(updatedSource),
      "both pushed frames to observe one source invalidation",
      10_000,
    );
    expect(count(readsOf(reads), source)).toBe(priorReads + 1);

    // An isolated origin in a different renderer must observe the descriptors
    // afresh while still reusing the payloads read by the layered origin.
    const beforeIsolated = readsOf(reads);
    const isolatedFrame = await request(
      "secondary-session",
      selected,
      secondTranscript,
      ["cc-candybar", "--config-only", config],
    );
    expect(textOf(isolatedFrame)).toContain(WORKTREE_MODEL);
    expect(textOf(isolatedFrame)).toContain(updatedSource);
    const distinctOrigins = readsOf(reads);
    for (const file of [config, definition]) {
      expect(count(distinctOrigins, file)).toBe(
        count(beforeIsolated, file) + 1,
      );
      expect(
        distinctOrigins.filter(
          (read) => read.file === file && read.operation === "payload",
        ),
      ).toEqual([{ file, operation: "payload", pid: daemon.child.pid }]);
    }

    expect(textOf(isolatedFrame)).toContain("padding=1");
    const wider = linksOf(isolatedFrame).find((link) => link.text === "WIDER");
    if (wider === undefined) throw new Error("the worktree did not draw WIDER");
    await click(isolated.sockPath, wider.url);
    await until(
      () => delivered("padding=2"),
      "both renderers drawing the landed config",
    );
    // [LAW:verifiable-goals] One open checks the old revision and one observes
    // the published revision. Only the published revision needs its bytes read.
    const pid = daemon.child.pid;
    const saveReads = readsOf(reads)
      .slice(distinctOrigins.length)
      .filter(({ file }) => file === config);
    expect(saveReads).toEqual([
      { file: config, operation: "openSync", pid },
      { file: config, operation: "openSync", pid },
      { file: config, operation: "payload", pid },
    ]);

    const conflict = await sendDaemonRequest(
      isolated.sockPath,
      {
        ...renderBody("conflicting-session", root, {}, args),
        v: PROTOCOL_VERSION,
        kind: "render",
        env: { ...TEST_ENV, CC_CANDYBAR_NAME: selected.name },
        client: {
          kind: "node",
          bundle: path.join(process.cwd(), "dist", "index.mjs"),
          source: null,
        },
      },
      1000,
    );
    expect(conflict).toMatchObject({
      ok: false,
      error: expect.stringContaining("renderer worktree is bound"),
    });

    const stats = await sendDaemonRequest(
      isolated.sockPath,
      { v: PROTOCOL_VERSION, kind: "stats" },
      1000,
    );
    expect(stats).toMatchObject({ ok: true, stats: { pid: daemon.child.pid } });
    const readLog = () =>
      fs.readFileSync(path.join(isolated.stateDir, "daemon.log"), "utf8");
    const children = [
      ...readLog().matchAll(/renderer (main|worktree)\[1\] started pid=(\d+)/g),
    ];
    expect(children.map((match) => match[1]).sort()).toEqual([
      "main",
      "worktree",
    ]);
    expect(new Set(children.map((match) => Number(match[2]))).size).toBe(2);
    expect(children.map((match) => Number(match[2]))).not.toContain(
      daemon.child.pid,
    );

    const worktreePid = Number(
      children.find((match) => match[1] === "worktree")?.[2],
    );
    if (!Number.isSafeInteger(worktreePid) || worktreePid < 1)
      throw new Error("expected the worktree renderer's live child pid");
    process.kill(worktreePid, "SIGKILL");
    const afterEnd = "main-feed-survives-worktree-end";
    fs.writeFileSync(source, `${afterEnd}\n`);
    await until(
      () =>
        standard.some((frame) => frame.includes(afterEnd)) &&
        /renderer worktree\[2\] started pid=/.test(readLog()),
      "the primary feed stays live during worktree recovery",
      8000,
    );
    // Both subscriptions survived the change of process. A fresh file
    // observation reaches its existing feed without another render request.
    const afterRecovery = "existing-feeds-after-worktree-restart";
    fs.writeFileSync(source, `${afterRecovery}\n`);
    await until(
      () => delivered(afterRecovery),
      "both existing feeds draw after the renderer restart",
      8_000,
    );
    expect(readLog().match(/renderer main\[\d+\] started pid=/g)).toHaveLength(
      1,
    );
  } finally {
    for (const stop of stopFeeds) stop();
    await daemon?.stop();
    isolated.removeTmpDirs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one project approval from an earlier frame covers both renderers, a config edit and a host restart", async () => {
  const isolated = prepareIsolatedDaemonEnv("cc-candybar-one-approval");
  const project = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-approved-project-")),
  );
  const alternate = path.join(project, "worktree.mjs");
  const writeProject = (label: string, rows = ["agreed"]) =>
    fs.writeFileSync(
      path.join(project, ".cc-candybar.json5"),
      JSON.stringify({
        segments: { agreed: { template: label } },
        root: { h: rows },
      }),
    );
  const session = (renderer: string, afterRestart: boolean) =>
    `approval-${renderer}-${afterRestart ? "restarted" : "initial"}`;
  const draw = (renderer: "main" | "worktree", afterRestart = false) =>
    frameRequest(isolated.sockPath, {
      ...renderBody(session(renderer, afterRestart), project),
      ...(renderer === "worktree" && {
        env: { ...TEST_ENV, CC_CANDYBAR_NAME: "worktree" },
        client: { kind: "node", bundle: alternate, source: null },
      }),
    });
  const bothSee = (labels: readonly string[], afterRestart = false) =>
    until(
      async () => {
        const frames = await Promise.all([
          draw("main", afterRestart),
          draw("worktree", afterRestart),
        ]);
        return frames.map(textOf).every((text) => labels.every((label) => text.includes(label)));
      },
      () => `both renderers to show ${labels.join(", ")}`,
      8_000,
    );
  let daemon: RunningDaemon | undefined;
  try {
    execFileSync("git", ["init", "-q", project]);
    fs.copyFileSync(worktreeBuilt, alternate);
    writeProject("PROJECT-APPROVED");
    daemon = await spawnDaemonWithEnv(isolated.env, builtDaemon);
    const before = await draw("main");
    expect(textOf(before)).not.toContain("PROJECT-APPROVED");
    expect(textOf(await draw("worktree"))).not.toContain("PROJECT-APPROVED");
    const pages = await readDiagnostics(
      isolated.sockPath,
      session("main", false),
      project,
      before,
    );
    const approve = findUrl(
      pages.flatMap(({ rendered }) => linksOf(rendered).map(({ url }) => url)),
      (effects) =>
        effects.some(
          ({ verb, args }) =>
            verb === VERB_REPO_CONFIG && args[2] === "approved",
        ),
    );
    if (approve === undefined) throw new Error("missing repository approval");
    expect(textOf(await draw("main"))).not.toContain("PROJECT-APPROVED");
    await click(isolated.sockPath, approve, 20_000);
    await bothSee(["PROJECT-APPROVED"]);
    const plugin = path.join(project, ".cc-candybar", "plugins", "marker");
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(
      path.join(plugin, "plugin.json5"),
      "{ segments: { row: { template: 'NEW-PLUGIN' } } }",
    );
    fs.writeFileSync(
      path.join(project, ".cc-candybar.local.json5"),
      "{ segments: { local: { template: 'NEW-LOCAL' } } }",
    );
    writeProject("PROJECT-EDITED", ["agreed", "local", "repo.marker.row"]);
    const edited = ["PROJECT-EDITED", "NEW-LOCAL", "NEW-PLUGIN"];
    await bothSee(edited);
    await daemon.stop();
    const answerFile = repoConfigsPath(isolated.stateDir);
    expect(JSON.parse(fs.readFileSync(answerFile, "utf8"))).toEqual({
      [project]: "approved",
    });
    fs.writeFileSync(
      answerFile,
      JSON.stringify({ [project + path.sep]: "approved" }),
    );
    daemon = await spawnDaemonWithEnv(isolated.env, builtDaemon);
    await bothSee(edited, true);
    const after = await readDiagnostics(
      isolated.sockPath,
      session("main", true),
      project,
      await draw("main", true),
    );
    expect(
      after.some(({ text }) => text.includes("a cc-candybar config for")),
    ).toBe(false);
    expect(repoConfigs(isolated.stateDir).read()).toEqual({
      kind: "ok",
      value: { [project]: "approved" },
    });
  } finally {
    await daemon?.stop();
    isolated.removeTmpDirs();
    fs.rmSync(project, { recursive: true, force: true });
  }
}, 30_000);

test("a delivered pane frame settles in the subprocess that drew it", async () => {
  const daemon = await spawnIsolatedDaemon("ccb-pane-receipt", builtDaemon);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-pane-receipt-"));
  try {
    const session = "pane-receipt";
    const config = path.join(dir, "config.json5");
    const text = "settle this pane";
    fs.writeFileSync(
      config,
      JSON.stringify({
        globals: { experimentalPane: true },
        segments: { sample: { template: text } },
        root: { h: ["sample"] },
      }),
    );
    const args = ["cc-candybar", "--config", config];
    const statusline = await frameRequest(
      daemon.sockPath,
      renderBody(session, dir, {}, args),
    );
    expect(textOf(statusline)).toContain(text);

    const pane = observePane(daemon.sockPath, session);
    try {
      await pane.waitFor((line) => line.includes(text), text);
      let pending: number | undefined;
      await until(
        async () => {
          const response = await sendDaemonRequest(daemon.sockPath, {
            v: PROTOCOL_VERSION,
            kind: "stats",
          });
          if (!response.ok || !("stats" in response))
            throw new Error(`no daemon stats: ${JSON.stringify(response)}`);
          pending = response.stats.rendererTurns.presents;
          return response.stats.frameFeeds.drawn > 0 && pending === 0;
        },
        () => `the delivered pane frame settled (${pending} pending)`,
        2_000,
      );
    } finally {
      pane.close();
    }
  } finally {
    await daemon.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the named renderer receives its pane control and earlier statusline run", async () => {
  const daemon = await spawnIsolatedDaemon("ccb-named-clicks", builtDaemon);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-click-source-"));
  try {
    const config = path.join(dir, "config.json5");
    const alternate = path.join(dir, "worktree.mjs");
    const record = path.join(dir, "run.json");
    fs.copyFileSync(worktreeBuilt, alternate);
    fs.writeFileSync(
      config,
      JSON.stringify({
        globals: { experimentalPane: true },
        variables: {
          shown: { kind: "input", path: "model.id", type: "string" },
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
        segments: { body: { template: '{{ action "remember" .shown }}' } },
        root: {
          h: [
            {
              kind: "group",
              name: "details",
              label: "details",
              open: true,
              children: ["body"],
            },
          ],
        },
      }),
    );

    const args = ["cc-candybar", "--config", config];
    const primarySession = "primary-click";
    const worktreeSession = "named-click";
    const draw = (session: string, value: string, named: boolean) =>
      renderRequest(daemon.sockPath, {
        ...renderBody(session, dir, {}, args),
        hookData: {
          ...hookData(session, dir),
          model: { id: value, display_name: value },
        },
        ...(named && {
          env: { ...TEST_ENV, CC_CANDYBAR_NAME: "worktree" },
          client: { kind: "node", bundle: alternate, source: null },
        }),
      });
    const runLink = (output: string) =>
      findUrl(urlsOfAnsi(output), (effects) =>
        effects.some(({ verb }) => verb === VERB_RUN),
      );
    expect(
      runLink(await draw(primarySession, "primary value", false)),
    ).toBeDefined();
    const oldLink = runLink(await draw(worktreeSession, "first value", true));
    if (oldLink === undefined)
      throw new Error("the named statusline drew no run");

    const pane = observePane(daemon.sockPath, worktreeSession);
    try {
      const before = await pane.waitFor(
        (text) => text.includes("first value"),
        "the named pane's first frame",
      );
      expect(runLink(before)).toBe(oldLink);
      const close = findUrl(urlsOfAnsi(before), (effects) =>
        effects.some(
          ({ verb, args }) =>
            verb === VERB_SET_STATE &&
            args[0] === worktreeSession &&
            args[2] === DISCLOSURE_CLOSED,
        ),
      );
      if (close === undefined) throw new Error("the named pane drew no close");

      await draw(worktreeSession, "second value", true);
      await pane.waitFor(
        (text) => text.includes("second value"),
        "the named pane's new input",
      );
      await click(daemon.sockPath, close);
      await pane.waitFor(
        (text) => !text.includes("second value") && text.includes("details"),
        "the named pane after closing",
      );
      expect(
        runLink(await draw(primarySession, "primary value", false)),
      ).toBeDefined();
    } finally {
      pane.close();
    }

    // A new frame can move the session to another renderer. The original
    // address still goes to its issuing renderer and keeps its captured data.
    await draw(worktreeSession, "moved value", false);
    await click(daemon.sockPath, oldLink);
    const expected = JSON.stringify(["first value", "first value"]);
    await until(
      () =>
        fs.existsSync(record) && fs.readFileSync(record, "utf8") === expected,
      "the earlier worktree run's captured data",
    );
    const log = fs.readFileSync(
      path.join(daemon.stateDir, "daemon.log"),
      "utf8",
    );
    expect(log).toMatch(/click .*sid=named-click.*renderer=worktree/);
  } finally {
    await daemon.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
