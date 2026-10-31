// [LAW:verifiable-goals] brandon-doctor-v62x.e91 through a REAL daemon over a
// REAL socket: the 🩺 doctor click reads the config load of the render-cache
// entry the session's bar is drawn from. The in-process suite
// (test/doctor-menu.test.ts) fakes that edge; this is the one place the
// daemon's own is exercised — a project config found first, a user config
// unread behind it, and a declaration the project config never uses.

import { processLauncher } from "../src/proc/launch";
import { builtBundle } from "./helpers/spawn-test-daemon";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  click,
  killAndWait,
  linkUrls,
  render,
  renderBody,
  renderRequest,
  stripAnsi,
  urlWriting,
} from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { effectsOf } from "./helpers/click";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";
import {
  VERB_DOCTOR_PROBE,
  VERB_DOCTOR_RUN,
  VERB_LOAD_CONFIG,
} from "../src/click/wire";
import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import { tryClickViaDaemon } from "../src/daemon/client";
import { parseHandlerUrl } from "../src/install/index";
import { checkByName } from "../src/doctor/checks";
import {
  probeUrlHandler,
  productionHandlerProbeEdge,
} from "../src/doctor/handler-probe";
import { PACKAGE_VERSION } from "../src/version";
import { loggedLines, renderLines } from "./helpers/daemon-log";
import { crateDigest } from "../src/source-digest";
import { productionInstallEdge } from "../src/doctor/edge";
import { installOf, rateLimitsOf } from "../src/doctor/cli";
import {
  parseDaemonClients,
  parseRateLimitSightings,
} from "../src/doctor/daemon-answer";
import { claudeConfigDir, detectClaudeConfigDir } from "../src/claude-settings";
import type { ClientHints } from "../src/daemon/protocol";
import type { StatsSnapshot } from "../src/daemon/stats";
import { answerRepo } from "./helpers/repo-approval";

jest.setTimeout(30_000);

// The report row wraps at the client's width; its text is what is asserted.
const flat = (rendered: string): string =>
  stripAnsi(rendered).replace(/\s+/g, " ");

test("the doctor's config row reports the session's own config load", async () => {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const userConfig = path.join(
    env.XDG_CONFIG_HOME!,
    "cc-candybar",
    "config.json5",
  );
  mkdirSync(path.dirname(userConfig), { recursive: true });
  writeFileSync(userConfig, "{}");
  const projectDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-project-")),
  );
  const projectConfig = path.join(projectDir, ".cc-candybar.json5");
  writeFileSync(projectConfig, `{ helpers: { idle: "x" } }`);
  // The project's config is the session's own: the user approved it.
  answerRepo(projectDir, "approved", env);

  let daemon: RunningDaemon | undefined;
  try {
    daemon = await spawnDaemonWithEnv(env);
    const SID = "doctor-e2e-1";
    const closed = await render(sockPath, SID, projectDir);
    await click(sockPath, urlWriting(closed, SETTINGS_ANCHOR, SETTINGS_OPEN));
    const opened = await render(sockPath, SID, projectDir);
    await click(sockPath, urlWriting(opened, `${SETTINGS_NS}tab`, "tools"));
    const tools = await render(sockPath, SID, projectDir);
    const run = linkUrls(tools).find((u) =>
      effectsOf(u).some((e) => e.verb === VERB_DOCTOR_RUN),
    );
    expect(run).toBeDefined();
    await click(sockPath, run!);

    // The project layer's unused helper, read over the user's file.
    expect(flat(await render(sockPath, SID, projectDir))).toContain(
      `✗ config — ${userConfig} < ${projectConfig} (searched): helper "idle" is never called`,
    );

    // Fixing it turns the row over on the very next run: the click reloads
    // the entry, so it never reports the load from before the edit while
    // the fs watcher catches up.
    writeFileSync(projectConfig, `{}`);
    await click(sockPath, run!);
    expect(flat(await render(sockPath, SID, projectDir))).toContain("✓ config");
  } finally {
    if (daemon) await killAndWait(daemon);
    removeTmpDirs();
  }
});

// What named the file reaches the click from the request that named it, so
// the row and `cc-candybar doctor` agree on it, and it is the spelling a person
// would have to change: `--config` wins even where the variable names one file.
test("the doctor's config row says what named the session's file", async () => {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const projectDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-project-")),
  );
  const named = path.join(projectDir, "named.json5");
  const picked = path.join(projectDir, "picked.json5");
  writeFileSync(named, "{}");
  writeFileSync(picked, "{}");
  // Wrapping may fall inside a path, so spaces are no part of what is read.
  const squeezed = (s: string): string => stripAnsi(s).replace(/\s+/g, "");

  let daemon: RunningDaemon | undefined;
  try {
    daemon = await spawnDaemonWithEnv(env);
    const row = async (
      sid: string,
      hints: ClientHints,
      args: string[],
    ): Promise<string> => {
      const draw = () => render(sockPath, sid, projectDir, hints, args);
      await click(sockPath, urlWriting(await draw(), SETTINGS_ANCHOR, SETTINGS_OPEN));
      await click(sockPath, urlWriting(await draw(), `${SETTINGS_NS}tab`, "tools"));
      const run = linkUrls(await draw()).find((u) =>
        effectsOf(u).some((e) => e.verb === VERB_DOCTOR_RUN),
      );
      await click(sockPath, run!);
      return squeezed(await draw());
    };
    const flag = ["cc-candybar", "--config", named];

    expect(await row("source-argument", { configEnv: named }, flag)).toContain(
      squeezed(`✓ config — ${named} (command argument)`),
    );
    expect(await row("source-env", { configEnv: named }, [])).toContain(
      squeezed(`✓ config — ${named} ($CC_CANDYBAR_CONFIG)`),
    );
    expect(await row("source-search", {}, [])).toContain(
      squeezed("✓ config — bundled default (no config file loaded)"),
    );

    await click(
      sockPath,
      `cc-candybar://${VERB_LOAD_CONFIG}/source-pick/${encodeURIComponent(picked)}`,
    );
    expect(await row("source-pick", { configEnv: named }, flag)).toContain(
      squeezed(`✓ config — ${picked} (load-config pick)`),
    );
  } finally {
    if (daemon) await killAndWait(daemon);
    removeTmpDirs();
  }
});

// brandon-doctor-v62x.a1z: the daemon's half of `cc-candybar doctor`'s probe,
// over the real socket — a `doctor-probe` click as the URL handler sends it
// (its own version on the request) is listed in the stats the CLI reads back,
// and the doctor row of a session reads the version its own click carried.
test("a probe click is listed in stats; a doctor click's handler version is its row", async () => {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const projectDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-project-")),
  );
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await spawnDaemonWithEnv(env);
    const request = (body: Record<string, unknown>) =>
      sendDaemonRequest(
        sockPath,
        { v: PROTOCOL_VERSION, ...body } as never,
        5000,
      );

    const nonce = "123e4567-e89b-42d3-a456-426614174000";
    expect(
      await request({
        kind: "click",
        verb: VERB_DOCTOR_PROBE,
        value: nonce,
        clientVersion: "0.0.1",
      }),
    ).toMatchObject({ ok: true });
    expect(await request({ kind: "stats" })).toMatchObject({
      ok: true,
      stats: { handlerProbes: [{ nonce, handler: "0.0.1" }] },
    });

    const SID = "doctor-e2e-2";
    await render(sockPath, SID, projectDir);
    expect(
      await request({
        kind: "click",
        verb: VERB_DOCTOR_RUN,
        value: SID,
        clientVersion: "0.0.1",
      }),
    ).toMatchObject({ ok: true });
    await click(
      sockPath,
      urlWriting(
        await render(sockPath, SID, projectDir),
        SETTINGS_ANCHOR,
        SETTINGS_OPEN,
      ),
    );
    await click(
      sockPath,
      urlWriting(
        await render(sockPath, SID, projectDir),
        `${SETTINGS_NS}tab`,
        "tools",
      ),
    );
    expect(flat(await render(sockPath, SID, projectDir))).toContain(
      "✗ URL handler — the URL handler runs cc-candybar 0.0.1; the bar runs",
    );
  } finally {
    if (daemon) await killAndWait(daemon);
    removeTmpDirs();
  }
});

// The CLI's probe end to end over real processes, less Launch Services: the
// production edge, with the one leg this test cannot isolate — macOS handing
// the link to the handler app, which would deliver it to the user's own
// daemon — replaced by what that app runs, `url-handle`'s own send.
test("the CLI's probe reads its own link back from the daemon it was delivered to", async () => {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const savedSocket = process.env.CC_CANDYBAR_SOCKET;
  process.env.CC_CANDYBAR_SOCKET = sockPath;
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await spawnDaemonWithEnv(env);
    const delivered: Promise<unknown>[] = [];
    const facts = await probeUrlHandler({
      ...productionHandlerProbeEdge(processLauncher),
      platform: "darwin",
      // The stand-in for the handler app below delivers to this daemon.
      sockets: { own: sockPath, handler: sockPath },
      open: (url) => {
        const { verb, value } = parseHandlerUrl(url);
        delivered.push(tryClickViaDaemon(verb, value));
        return null;
      },
    });
    expect(await Promise.all(delivered)).toMatchObject([{ kind: "ok" }]);
    expect(facts).toEqual({
      kind: "arrived",
      handler: PACKAGE_VERSION,
      bar: PACKAGE_VERSION,
    });
    expect(
      checkByName("urlHandler")!.probe({ urlHandler: facts } as never),
    ).toEqual({ ok: true });
  } finally {
    if (savedSocket === undefined) delete process.env.CC_CANDYBAR_SOCKET;
    else process.env.CC_CANDYBAR_SOCKET = savedSocket;
    if (daemon) await killAndWait(daemon);
    removeTmpDirs();
  }
});

// brandon-doctor-v62x.tfb through a real daemon: a render request records its
// session's client, daemon-stats serves each session's latest, and the CLI's
// reading of them is the install verdict. The daemon runs this checkout's
// built bundle (`pnpm build` first), so it names the checkout's dist and a native client of
// it must carry the crateDigest of the checkout's rust-client.
test("the clients the daemon saw render are the install check's facts", async () => {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const projectDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-project-")),
  );
  const repo = process.cwd();
  const native = {
    kind: "native",
    bundle: path.join(repo, "bin", "..", "dist", "index.mjs"),
    source: crateDigest(path.join(repo, "rust-client")),
  } as const;
  let daemon: RunningDaemon | undefined;
  try {
    // The built bundle, as production runs it: a daemon from src/ under tsx
    // runs no bundle, and names the module it was loaded from.
    daemon = await spawnDaemonWithEnv(
      env,
      builtBundle(path.join(repo, "dist", "index.mjs")),
    );
    const verdict = async () => {
      const resp = await sendDaemonRequest(
        sockPath,
        { v: PROTOCOL_VERSION, kind: "stats" } as never,
        5000,
      );
      const stats = (resp as { stats: StatsSnapshot }).stats;
      const asked = parseDaemonClients(stats);
      const install = installOf(
        productionInstallEdge,
        { kind: "recent" },
        asked,
      );
      return checkByName("install")!.probe({ install } as never);
    };

    await render(sockPath, "install-e2e-1", projectDir, { client: native });
    expect(await verdict()).toEqual({ ok: true });

    // A second session drawn by a client too old to report itself.
    await render(sockPath, "install-e2e-2", projectDir);
    expect(await verdict()).toEqual({
      ok: false,
      reason: `the bar is drawn by a statusline client too old to say what it is — run \`just install-rust\` and point the statusLine command at ${repo}/bin/cc-candybar-native`,
      more: [],
    });

    // Its next render, by the current client, replaces it at once.
    await render(sockPath, "install-e2e-2", projectDir, { client: native });
    expect(await verdict()).toEqual({ ok: true });
  } finally {
    if (daemon) await killAndWait(daemon);
    removeTmpDirs();
  }
});

// brandon-doctor-v62x.onf through a real daemon: a render request records
// whether its payload carried the rate-limit windows, and with which Claude
// Code directory its session runs; daemon-stats serves both, and the CLI's
// reading keeps only its own directory's recent renders.
test("the rate-limit windows each render carried are the segment-data row's facts", async () => {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const projectDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-project-")),
  );
  const ownDir = claudeConfigDir(
    detectClaudeConfigDir(process.env, projectDir),
  );
  const answered = {
    total_input_tokens: 10,
    total_output_tokens: 5,
    context_window_size: 200000,
    used_percentage: 1,
    remaining_percentage: 99,
    current_usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
  const renderWith = (
    sid: string,
    extra: Record<string, unknown>,
    hints: ClientHints = {},
  ) => {
    const body = renderBody(sid, projectDir, hints);
    return renderRequest(sockPath, {
      ...body,
      hookData: { ...(body.hookData as object), ...extra },
    });
  };
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await spawnDaemonWithEnv(env);
    const seen = async () => {
      const resp = await sendDaemonRequest(
        sockPath,
        { v: PROTOCOL_VERSION, kind: "stats" } as never,
        5000,
      );
      return rateLimitsOf(
        { kind: "recent" },
        parseRateLimitSightings((resp as { stats: StatsSnapshot }).stats),
        ownDir,
      );
    };

    await renderWith("rl-1", {
      context_window: answered,
      rate_limits: { five_hour: { used_percentage: 3, resets_at: 1 } },
    });
    await renderWith("rl-2", { context_window: answered });
    // A session of another Claude Code directory says nothing of this one.
    await renderWith(
      "rl-3",
      { context_window: answered },
      { claudeConfigDir: "/elsewhere/.claude" },
    );
    expect(await seen()).toEqual({ kind: "ok", value: ["carried", "missing"] });

    // The next render of a session replaces what it said.
    await renderWith("rl-2", {
      context_window: { ...answered, current_usage: null },
    });
    expect(await seen()).toEqual({
      kind: "ok",
      value: ["carried", "unanswered"],
    });
  } finally {
    if (daemon) await killAndWait(daemon);
    removeTmpDirs();
  }
});

// brandon-doctor-v62x.p4l: the transcript the session's render named, read by
// the doctor click — through the real socket, the render's sighting and the
// daemon's own edge.
test("the session data row reads the transcript the session's render named", async () => {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const projectDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-project-")),
  );
  const transcript = path.join(projectDir, "session.jsonl");
  writeFileSync(transcript, `{"type":"user"}\nnot json\n`);
  const SID = "doctor-e2e-transcript";
  const renderT = () => {
    const body = renderBody(SID, projectDir);
    return renderRequest(sockPath, {
      ...body,
      hookData: { ...(body.hookData as object), transcript_path: transcript },
    });
  };
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await spawnDaemonWithEnv(env);
    const closed = await renderT();
    await click(sockPath, urlWriting(closed, SETTINGS_ANCHOR, SETTINGS_OPEN));
    const opened = await renderT();
    await click(sockPath, urlWriting(opened, `${SETTINGS_NS}tab`, "tools"));
    const run = linkUrls(await renderT()).find((u) =>
      effectsOf(u).some((e) => e.verb === VERB_DOCTOR_RUN),
    );
    expect(run).toBeDefined();
    await click(sockPath, run!);
    expect(flat(await renderT())).toContain(
      `✗ session data — 1 of the 2 lines in the transcript ${transcript} are not JSON objects`,
    );

    writeFileSync(transcript, `{"type":"user"}\n`);
    await click(sockPath, run!);
    expect(flat(await renderT())).toContain("✓ session data");
  } finally {
    if (daemon) await killAndWait(daemon);
    removeTmpDirs();
  }
});

// brandon-doctor-v62x.tgp: the effect-refresh row reads what the session's
// bar drew, through a real daemon. A bar whose only motion is a template's
// `frames` — no effect, no transitions — fails the row while its statusLine
// sets no refreshInterval, and the same bar drawn still passes; each render
// event says which.
test("a bar whose only motion is a template's fails effect refresh", async () => {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const projectDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-project-")),
  );
  const claudeDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-claude-")),
  );
  writeFileSync(
    path.join(claudeDir, "settings.json"),
    `{ "statusLine": { "type": "command", "command": "cc-candybar" } }`,
  );
  const projectConfig = path.join(projectDir, ".cc-candybar.json5");
  const barOf = (template: string): string =>
    `{ segments: { cell: { template: ${JSON.stringify(template)} } }, root: { h: ["cell"] } }`;
  writeFileSync(projectConfig, barOf('{{ frames 1 "a" 1 "b" }}'));
  answerRepo(projectDir, "approved", env);

  let daemon: RunningDaemon | undefined;
  try {
    daemon = await spawnDaemonWithEnv(env);
    const SID = "doctor-e2e-frames";
    const hints = { claudeConfigDir: claudeDir };
    let drawn = 0;
    const draw = () => {
      drawn++;
      return render(sockPath, SID, projectDir, hints);
    };
    await click(
      sockPath,
      urlWriting(await draw(), SETTINGS_ANCHOR, SETTINGS_OPEN),
    );
    await click(
      sockPath,
      urlWriting(await draw(), `${SETTINGS_NS}tab`, "tools"),
    );
    const run = linkUrls(await draw()).find((u) =>
      effectsOf(u).some((e) => e.verb === VERB_DOCTOR_RUN),
    );
    expect(run).toBeDefined();
    await click(sockPath, run!);
    expect(flat(await draw())).toContain(
      "✗ effect refresh — the bar moves (an effect, a fade, an animated segment, or an open menu counting down to its close), but its statusLine sets no refreshInterval",
    );

    writeFileSync(projectConfig, barOf("still"));
    await click(sockPath, run!);
    await draw();
    await click(sockPath, run!);
    // Still, but drawn under the open menu the doctor is clicked from, which
    // counts down to the flash before it closes on its own: the frame says
    // when that starts (candybar-animation-wbxz.014), so the bar moves.
    expect(flat(await draw())).toContain(
      "✗ effect refresh — the bar moves (an effect, a fade, an animated segment, or an open menu counting down to its close)",
    );

    // The same bar with its menu closed is still, and passes.
    await click(
      sockPath,
      urlWriting(await draw(), SETTINGS_ANCHOR, DISCLOSURE_CLOSED),
    );
    await draw();
    await click(sockPath, run!);
    await click(
      sockPath,
      urlWriting(await draw(), SETTINGS_ANCHOR, SETTINGS_OPEN),
    );
    await click(
      sockPath,
      urlWriting(await draw(), `${SETTINGS_NS}tab`, "tools"),
    );
    expect(flat(await draw())).toContain("✓ effect refresh");

    const events = await renderLines(env, SID, drawn);
    const motion = events.map((l) => l.match(/ motion=(\S+) /)?.[1]);
    expect(motion[0]).toBe("moves");
    expect(motion).toContain("can-move");
    // The render event says how long a drawn menu has sat idle, of its timeout.
    const menuIdle = events.map((l) => l.match(/ menuIdle=(\S+) /)?.[1]);
    expect(menuIdle[0]).toBe("-");
    expect(menuIdle).toContainEqual(expect.stringMatching(/^\d+\.\ds\/120s$/));
    expect(motion).toContain("still");
    const doctorLines = (lines: readonly string[]) =>
      lines.filter(
        (l) => l.includes("doctor:") && l.includes(`session=${SID}`),
      );
    expect(
      (
        await loggedLines(
          env,
          doctorLines,
          (found) => found.length >= 4,
          "the doctor's four runs",
        )
      ).map((l) => l.match(/ frames=(\S+) /)?.[1]),
      // The third run's still bar sits under a menu counting down to its
      // close, which moves it; the fourth's menu is closed.
    ).toEqual(["1/0/0/0/0", "1/0/0/0/0", "1/0/0/0/0", "0/0/1/0/0"]);
  } finally {
    if (daemon) await killAndWait(daemon);
    removeTmpDirs();
  }
});
