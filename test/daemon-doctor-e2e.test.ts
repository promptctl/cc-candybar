// [LAW:verifiable-goals] brandon-doctor-v62x.e91 through the daemon's own
// request handling: the 🩺 doctor click reads the config load of the render-cache
// entry the session's bar is drawn from. The in-process suite
// (test/doctor-menu.test.ts) fakes that edge; this is the one place the
// daemon's own is exercised — a project config found first, a user config
// unread behind it, and a declaration the project config never uses.

import { processLauncher } from "../src/proc/launch";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  click,
  linkUrls,
  render,
  renderBody,
  renderRequest,
  stripAnsi,
  urlWriting,
} from "./helpers/daemon-e2e";
import { bundleAt, startDaemon, statsOf } from "./helpers/in-worker-daemon";
import {
  prepareIsolatedDaemonEnv,
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
import { answerRepo } from "./helpers/repo-approval";

jest.setTimeout(30_000);

// The report row wraps at the client's width; its text is what is asserted.
const flat = (rendered: string): string =>
  stripAnsi(rendered).replace(/\s+/g, " ");

test("the doctor's config row reports the session's own config load", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
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

  const daemon = startDaemon(env);
  try {
    const SID = "doctor-e2e-1";
    const closed = await render(daemon, SID, projectDir);
    await click(daemon, urlWriting(closed, SETTINGS_ANCHOR, SETTINGS_OPEN));
    const opened = await render(daemon, SID, projectDir);
    await click(daemon, urlWriting(opened, `${SETTINGS_NS}tab`, "tools"));
    const tools = await render(daemon, SID, projectDir);
    const run = linkUrls(tools).find((u) =>
      effectsOf(u).some((e) => e.verb === VERB_DOCTOR_RUN),
    );
    expect(run).toBeDefined();
    await click(daemon, run!);

    // The project layer's unused helper, read over the user's file.
    expect(flat(await render(daemon, SID, projectDir))).toContain(
      `✗ config — ${userConfig} < ${projectConfig} (searched): helper "idle" is never called`,
    );

    // Fixing it turns the row over on the very next run: the click reloads
    // the entry, so it never reports the load from before the edit while
    // the fs watcher catches up.
    writeFileSync(projectConfig, `{}`);
    await click(daemon, run!);
    expect(flat(await render(daemon, SID, projectDir))).toContain("✓ config");
  } finally {
    await daemon.stop();
    removeTmpDirs();
  }
});

// What named the file reaches the click from the request that named it, so
// the row and `cc-candybar doctor` agree on it, and it is the spelling a person
// would have to change: `--config` wins even where the variable names one file.
test("the doctor's config row says what named the session's file", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
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

  const daemon = startDaemon(env);
  try {
    const row = async (
      sid: string,
      hints: ClientHints,
      args: string[],
    ): Promise<string> => {
      const draw = () => render(daemon, sid, projectDir, hints, args);
      await click(daemon, urlWriting(await draw(), SETTINGS_ANCHOR, SETTINGS_OPEN));
      await click(daemon, urlWriting(await draw(), `${SETTINGS_NS}tab`, "tools"));
      const run = linkUrls(await draw()).find((u) =>
        effectsOf(u).some((e) => e.verb === VERB_DOCTOR_RUN),
      );
      await click(daemon, run!);
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
      daemon,
      `cc-candybar://${VERB_LOAD_CONFIG}/source-pick/${encodeURIComponent(picked)}`,
    );
    expect(await row("source-pick", { configEnv: named }, flag)).toContain(
      squeezed(`✓ config — ${picked} (load-config pick)`),
    );
  } finally {
    await daemon.stop();
    removeTmpDirs();
  }
});

// brandon-doctor-v62x.a1z: the daemon's half of `cc-candybar doctor`'s probe,
// over the wire — a `doctor-probe` click as the URL handler sends it
// (its own version on the request) is listed in the stats the CLI reads back,
// and the doctor row of a session reads the version its own click carried.
test("a probe click is listed in stats; a doctor click's handler version is its row", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const projectDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-project-")),
  );
  const daemon = startDaemon(env);
  try {
    const request = (body: Record<string, unknown>) =>
      sendDaemonRequest(
        daemon,
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
    expect((await statsOf(daemon.daemon)).handlerProbes).toMatchObject([
      { nonce, handler: "0.0.1" },
    ]);

    const SID = "doctor-e2e-2";
    await render(daemon, SID, projectDir);
    expect(
      await request({
        kind: "click",
        verb: VERB_DOCTOR_RUN,
        value: SID,
        clientVersion: "0.0.1",
      }),
    ).toMatchObject({ ok: true });
    await click(
      daemon,
      urlWriting(
        await render(daemon, SID, projectDir),
        SETTINGS_ANCHOR,
        SETTINGS_OPEN,
      ),
    );
    await click(
      daemon,
      urlWriting(
        await render(daemon, SID, projectDir),
        `${SETTINGS_NS}tab`,
        "tools",
      ),
    );
    expect(flat(await render(daemon, SID, projectDir))).toContain(
      "✗ URL handler — the URL handler runs cc-candybar 0.0.1; the bar runs",
    );
  } finally {
    await daemon.stop();
    removeTmpDirs();
  }
});

// The CLI's probe end to end over a real socket, less Launch Services: the
// production edge, with the one leg this test cannot isolate — macOS handing
// the link to the handler app, which would deliver it to the user's own
// daemon — replaced by what that app runs, `url-handle`'s own send.
test("the CLI's probe reads its own link back from the daemon it was delivered to", async () => {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  // The env it places names this socket, which is where the CLI's send looks.
  const daemon = startDaemon(env);
  try {
    await daemon.listen(sockPath);
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
    await daemon.stop();
    removeTmpDirs();
  }
});

// brandon-doctor-v62x.tfb through a daemon: a render request records its
// session's client, daemon-stats serves each session's latest, and the CLI's
// reading of them is the install verdict. The daemon runs from a checkout laid
// down here, so it names that checkout's dist, and a native client of it must
// carry the crateDigest of that checkout's rust-client.
test("the clients the daemon saw render are the install check's facts", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const projectDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-project-")),
  );
  // What `installFacts` reads of an install: the bundle resolves, `src/` says
  // it is a checkout, and the crate's digest is the checkout's.
  const repo = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-checkout-")),
  );
  mkdirSync(path.join(repo, "src"));
  mkdirSync(path.join(repo, "dist"));
  writeFileSync(path.join(repo, "dist", "index.mjs"), "");
  cpSync(
    path.join(process.cwd(), "rust-client", "Cargo.toml"),
    path.join(repo, "rust-client", "Cargo.toml"),
    { recursive: true },
  );
  const native = {
    kind: "native",
    bundle: path.join(repo, "bin", "..", "dist", "index.mjs"),
    source: crateDigest(path.join(repo, "rust-client")),
  } as const;
  const daemon = startDaemon(env, { bundle: bundleAt(repo) });
  try {
    const verdict = async () => {
      const asked = parseDaemonClients(await statsOf(daemon.daemon));
      const install = installOf(
        productionInstallEdge,
        { kind: "recent" },
        asked,
      );
      return checkByName("install")!.probe({ install } as never);
    };

    await render(daemon, "install-e2e-1", projectDir, { client: native });
    expect(await verdict()).toEqual({ ok: true });

    // A second session drawn by a client too old to report itself.
    await render(daemon, "install-e2e-2", projectDir);
    expect(await verdict()).toEqual({
      ok: false,
      reason: `the bar is drawn by a statusline client too old to say what it is — run \`just install-rust\` and point the statusLine command at ${repo}/bin/cc-candybar-native`,
      more: [],
    });

    // Its next render, by the current client, replaces it at once.
    await render(daemon, "install-e2e-2", projectDir, { client: native });
    expect(await verdict()).toEqual({ ok: true });
  } finally {
    await daemon.stop();
    removeTmpDirs();
    rmSync(repo, { recursive: true, force: true });
  }
});

// brandon-doctor-v62x.onf through a daemon: a render request records
// whether its payload carried the rate-limit windows, and with which Claude
// Code directory its session runs; daemon-stats serves both, and the CLI's
// reading keeps only its own directory's recent renders.
test("the rate-limit windows each render carried are the segment-data row's facts", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
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
    return renderRequest(daemon, {
      ...body,
      hookData: { ...(body.hookData as object), ...extra },
    });
  };
  const daemon = startDaemon(env);
  try {
    const seen = async () => {
      return rateLimitsOf(
        { kind: "recent" },
        parseRateLimitSightings(await statsOf(daemon.daemon)),
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
    await daemon.stop();
    removeTmpDirs();
  }
});

// brandon-doctor-v62x.p4l: the transcript the session's render named, read by
// the doctor click — through the wire, the render's sighting and the
// daemon's own edge.
test("the session data row reads the transcript the session's render named", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
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
    return renderRequest(daemon, {
      ...body,
      hookData: { ...(body.hookData as object), transcript_path: transcript },
    });
  };
  const daemon = startDaemon(env);
  try {
    const closed = await renderT();
    await click(daemon, urlWriting(closed, SETTINGS_ANCHOR, SETTINGS_OPEN));
    const opened = await renderT();
    await click(daemon, urlWriting(opened, `${SETTINGS_NS}tab`, "tools"));
    const run = linkUrls(await renderT()).find((u) =>
      effectsOf(u).some((e) => e.verb === VERB_DOCTOR_RUN),
    );
    expect(run).toBeDefined();
    await click(daemon, run!);
    expect(flat(await renderT())).toContain(
      `✗ session data — 1 of the 2 lines in the transcript ${transcript} are not JSON objects`,
    );

    writeFileSync(transcript, `{"type":"user"}\n`);
    await click(daemon, run!);
    expect(flat(await renderT())).toContain("✓ session data");
  } finally {
    await daemon.stop();
    removeTmpDirs();
  }
});

// brandon-doctor-v62x.tgp: the effect-refresh row reads what the session's
// bar drew, through a daemon. A bar whose only motion is a template's
// `frames` — no effect, no transitions — fails the row while its statusLine
// sets no refreshInterval, and the same bar drawn still passes; each render
// event says which.
test("a bar whose only motion is a template's fails effect refresh", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
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

  const daemon = startDaemon(env);
  try {
    const SID = "doctor-e2e-frames";
    const hints = { claudeConfigDir: claudeDir };
    let drawn = 0;
    const draw = () => {
      drawn++;
      return render(daemon, SID, projectDir, hints);
    };
    await click(
      daemon,
      urlWriting(await draw(), SETTINGS_ANCHOR, SETTINGS_OPEN),
    );
    await click(
      daemon,
      urlWriting(await draw(), `${SETTINGS_NS}tab`, "tools"),
    );
    const run = linkUrls(await draw()).find((u) =>
      effectsOf(u).some((e) => e.verb === VERB_DOCTOR_RUN),
    );
    expect(run).toBeDefined();
    await click(daemon, run!);
    expect(flat(await draw())).toContain(
      "✗ effect refresh — the bar moves (an effect, a fade, an animated segment, or an open menu counting down to its close), but its statusLine sets no refreshInterval",
    );

    writeFileSync(projectConfig, barOf("still"));
    await click(daemon, run!);
    await draw();
    await click(daemon, run!);
    // Still, but drawn under the open menu the doctor is clicked from, which
    // counts down to the flash before it closes on its own: the frame says
    // when that starts (candybar-animation-wbxz.014), so the bar moves.
    expect(flat(await draw())).toContain(
      "✗ effect refresh — the bar moves (an effect, a fade, an animated segment, or an open menu counting down to its close)",
    );

    // The same bar with its menu closed is still, and passes.
    await click(
      daemon,
      urlWriting(await draw(), SETTINGS_ANCHOR, DISCLOSURE_CLOSED),
    );
    await draw();
    await click(daemon, run!);
    await click(
      daemon,
      urlWriting(await draw(), SETTINGS_ANCHOR, SETTINGS_OPEN),
    );
    await click(
      daemon,
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
    await daemon.stop();
    removeTmpDirs();
  }
});
