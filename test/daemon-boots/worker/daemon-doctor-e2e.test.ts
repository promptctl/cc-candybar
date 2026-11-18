// [LAW:verifiable-goals] brandon-doctor-v62x.e91 through the daemon's own
// request handling: the 🩺 doctor click reads the config load of the render-cache
// entry the session's bar is drawn from. The in-process suite
// (test/doctor-menu.test.ts) fakes that edge; this is the one place the
// daemon's own is exercised — a project config found first, a user config
// unread behind it, and a declaration the project config never uses.

import { cellLen } from "@promptctl/rich-js";
import { HOST, WORLD } from "../../helpers/host";

import { textOf, type Frame } from "../../../src/render/frame";
import { linkUrls } from "../../helpers/frame";
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
  frameRequest,
  render,
  renderBody,
  renderRequest,
  urlWriting,
  drawnLink,
} from "../../helpers/daemon-e2e";
import { bundleAt, startDaemon, statsOf } from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { effectsOf } from "../../helpers/click";
import {
  SETTINGS_ANCHOR,
  SETTINGS_OPEN,
} from "../../../src/config/settings-menu";
import { DISCLOSURE_CLOSED } from "../../../src/config/disclosure";
import { SETTINGS_NS } from "../../../src/config/reserved-names";
import { VERB_DOCTOR_RUN } from "../../../src/click/wire";
import {
  URL_FRAME_KIND,
  URL_FRAME_VERSION,
  encodeFrame,
} from "../../../src/daemon/foundations/protocol";
import { checkByName, held } from "../../../src/doctor/checks";
import { DEFAULT_TERMINAL_WIDTH } from "../../../src/render/strip";
import { applyClaudeCodeReserve } from "../../../src/utils/terminal-width";
import { loggedLines, logLines, renderLines } from "../../helpers/daemon-log";
import { crateDigest } from "../../../src/source-digest";
import { installFacts, productionInstallEdge } from "../../../src/doctor/edge";
import { daemonSighted } from "../../../src/daemon/cache/doctor";
import { sessionIdOf } from "../../../src/daemon/foundations/session-id";
import type { StatsSnapshot } from "../../../src/daemon/foundations/stats-snapshot";
import { fieldsOf } from "../../../src/utils/logfmt";
import type { ClientHints } from "../../../src/daemon/foundations/protocol";
import { answerRepo } from "../../helpers/repo-approval";
import { until } from "../../helpers/until";

jest.setTimeout(30_000);

// What the daemon tells a doctor read of session `sid`, out of its stats.
const sightedOf = (stats: StatsSnapshot, sid: string) =>
  daemonSighted(
    sessionIdOf(sid),
    stats.clients.filter((c) => c.sessionId === sid),
    stats.daemon,
    stats.bundle,
  );

// A report row wraps at the client's width, through a path or a word, and a
// strip cap closes each line it breaks at, so whitespace and caps are no part of
// what is read. Removing them would read an over-wide row whole too, and Claude
// Code cuts that row's right end past the frame, so every row is held to the
// width it was drawn at: that is what makes the reason readable.
const WIDTH = applyClaudeCodeReserve(DEFAULT_TERMINAL_WIDTH);
const squeezed = (s: string): string => s.replace(/[\s\uE000-\uF8FF]/gu, "");
const flat = (rendered: Frame): string => {
  const text = textOf(rendered);
  expect(text.split("\n").filter((row) => cellLen(row) > WIDTH)).toEqual([]);
  return squeezed(text);
};
// The report lands in a world state after the click's own, once the host's
// read of the machine is in, so a row is drawn once it has landed.
const reported = async (
  draw: () => Promise<Frame>,
  row: string,
): Promise<void> => {
  let drawn = "";
  await until(
    async () => (drawn = flat(await draw())).includes(squeezed(row)),
    () => `the report row ${JSON.stringify(row)}; last drawn: ${drawn}`,
  );
};

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
    const draw = () => render(daemon, SID, projectDir);
    await reported(
      draw,
      `✗ config — ${userConfig} < ${projectConfig} (searched): helper "idle" is never called`,
    );

    // Fixing it turns the row over on the next run once the origin's watch
    // has moved its config: a run reads the load the config turn made.
    const loads = (lines: readonly string[]): string[] =>
      lines.filter(
        (l) => l.includes(" config loaded ") && l.includes(" cause=config "),
      );
    const before = loads(logLines(env)).length;
    writeFileSync(projectConfig, `{}`);
    await loggedLines(
      env,
      loads,
      (picked) => picked.length > before,
      "the config turn of the edited project layer",
    );
    await click(daemon, run!);
    await reported(draw, "✓ config");
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
  writeFileSync(named, "{}");

  const daemon = startDaemon(env);
  try {
    const row = async (
      sid: string,
      hints: ClientHints,
      args: string[],
      expected: string,
    ): Promise<void> => {
      const draw = () => render(daemon, sid, projectDir, hints, args);
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
      await click(daemon, run!);
      await reported(draw, expected);
    };
    const flag = ["cc-candybar", "--config", named];

    await row(
      "source-argument",
      { configEnv: named },
      flag,
      `✓ config — ${named} (command argument)`,
    );
    await row(
      "source-env",
      { configEnv: named },
      [],
      `✓ config — ${named} ($CC_CANDYBAR_CONFIG)`,
    );
    await row(
      "source-search",
      {},
      [],
      "✓ config — bundled default (no config file loaded)",
    );
  } finally {
    await daemon.stop();
    removeTmpDirs();
  }
});

// A url frame as the URL handler forwards it (versioned by itself, no `v`)
// that the daemon cannot read is refused on its click event, and the doctor
// row of a session reads its own click's delivery. Every url frame writes a
// click event, the refused ones included (candybar-daemon-health-ajx0.co4).
// [LAW:nothing-unseen]
test("a url frame the daemon cannot read is refused on its click event; a doctor click's delivery is its row", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const projectDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-project-")),
  );
  const daemon = startDaemon(env);
  try {
    // As the URL handler app forwards: one frame, then hang up, reading no
    // answer. The daemon writes none. Each click's event is awaited before
    // the next frame, so the events below come in the order sent.
    const clickEvents = (lines: readonly string[]) =>
      lines.filter((l) => / click req=\d+ queued=/.test(l));
    let clicks = 0;
    const forwarded = async (frame: Record<string, unknown>) => {
      daemon.connect().end(encodeFrame({ kind: URL_FRAME_KIND, ...frame }));
      clicks += 1;
      const n = clicks;
      await loggedLines(
        env,
        clickEvents,
        (picked) => picked.length >= n,
        `${n} click events`,
      );
    };

    // A frame the daemon cannot read is refused on its click event, with the
    // frame's own facts, since the forwarder reads no answer.
    await forwarded({ urlV: 99, url: "cc-candybar://copy/x" });
    await forwarded({ urlV: 1, url: "https://example.com/" });
    await forwarded({ urlV: 1 });
    const events = await loggedLines(
      env,
      clickEvents,
      (picked) => picked.length >= 3,
      "three click events",
    );
    expect(events[0]).toMatch(
      / via=forwarder urlV=99 .* outcome=bad-request problems="the URL handler's frame version 99 is not one this daemon speaks \(1, 2\)"/,
    );
    expect(events[1]).toMatch(
      / via=forwarder urlV=1 .* outcome=bad-request problems="expected a cc-candybar:\/\/ link, got: https:\/\/example.com\/"/,
    );
    expect(events[2]).toMatch(
      / via=forwarder urlV=1 .* outcome=bad-request problems="the URL handler's frame carries no url string"/,
    );

    const SID = "doctor-e2e-2";
    await render(daemon, SID, projectDir);
    await click(
      daemon,
      drawnLink(daemon, `cc-candybar://${VERB_DOCTOR_RUN}/${SID}`),
    );
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
      squeezed(
        "✗ URL handler — the link was delivered by a click request (`cc-candybar url-handle`), not the forwarder app",
      ),
    );
  } finally {
    await daemon.stop();
    removeTmpDirs();
  }
});

// brandon-doctor-v62x.tfb through a daemon: a render request records its
// session's client, daemon-stats serves each session's latest, and what the
// daemon tells a session's doctor read of them is that session's install
// verdict. The daemon runs from a checkout laid
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
    const verdict = async (sid: string) => {
      const { clients } = sightedOf(await statsOf(daemon.daemon), sid);
      if (clients.kind !== "held") throw new Error("the daemon holds clients");
      const install = held(
        installFacts(
          productionInstallEdge,
          clients.value.bundle,
          clients.value.clients,
        ),
      );
      return checkByName("install")!.probe({ install } as never);
    };

    await render(daemon, "install-e2e-1", projectDir, { client: native });
    expect(await verdict("install-e2e-1")).toEqual({ ok: true });

    // A second session drawn by a client too old to report itself.
    await render(daemon, "install-e2e-2", projectDir);
    expect(await verdict("install-e2e-2")).toEqual({
      ok: false,
      reason: `the bar is drawn by a statusline client too old to say what it is — run \`just install-rust\` and point the statusLine command at ${repo}/bin/cc-candybar-native`,
      more: [],
    });

    // Its next render, by the current client, replaces it at once.
    await render(daemon, "install-e2e-2", projectDir, { client: native });
    expect(await verdict("install-e2e-2")).toEqual({ ok: true });
  } finally {
    await daemon.stop();
    removeTmpDirs();
    rmSync(repo, { recursive: true, force: true });
  }
});

// brandon-doctor-v62x.onf through a daemon: a render request records
// whether its payload carried the rate-limit windows, and what the daemon
// tells a session's doctor read is its own renders'.
test("the rate-limit windows each render carried are the segment-data row's facts", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-doctor-e2e",
  );
  const projectDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-e2e-project-")),
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
  const renderWith = (sid: string, extra: Record<string, unknown>) => {
    const body = renderBody(sid, projectDir);
    return renderRequest(daemon, {
      ...body,
      hookData: { ...(body.hookData as object), ...extra },
    });
  };
  const daemon = startDaemon(env);
  try {
    const seen = async (sid: string) =>
      sightedOf(await statsOf(daemon.daemon), sid).rateLimits;

    await renderWith("rl-1", {
      context_window: answered,
      rate_limits: { five_hour: { used_percentage: 3, resets_at: 1 } },
    });
    await renderWith("rl-2", { context_window: answered });
    expect(await seen("rl-1")).toEqual(held(["carried"]));
    expect(await seen("rl-2")).toEqual(held(["missing"]));

    // The next render of a session replaces what it said.
    await renderWith("rl-2", {
      context_window: { ...answered, current_usage: null },
    });
    expect(await seen("rl-2")).toEqual(held(["unanswered"]));
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
    return frameRequest(daemon, {
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
    await reported(
      renderT,
      `✗ session data — 1 of the 2 lines in the transcript ${transcript} are not JSON objects`,
    );

    writeFileSync(transcript, `{"type":"user"}\n`);
    await click(daemon, run!);
    await reported(renderT, "✓ session data");
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
    await click(daemon, urlWriting(await draw(), `${SETTINGS_NS}tab`, "tools"));
    const run = linkUrls(await draw()).find((u) =>
      effectsOf(u).some((e) => e.verb === VERB_DOCTOR_RUN),
    );
    expect(run).toBeDefined();
    await click(daemon, run!);
    await reported(
      draw,
      "✗ effect refresh — the bar moves (an effect, a fade, an animated segment, or an open menu counting down to its close), but its statusLine sets no refreshInterval",
    );

    // The config is polled, so the doctor runs once the bar draws the edit.
    writeFileSync(projectConfig, barOf("at rest"));
    await reported(draw, "at rest");
    await click(daemon, run!);
    await draw();
    await click(daemon, run!);
    // Still, but drawn under the open menu the doctor is clicked from, which
    // counts down to the flash before it closes on its own: the frame says
    // when that starts (candybar-animation-wbxz.014), so the bar moves.
    await reported(
      draw,
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
    await click(daemon, urlWriting(await draw(), `${SETTINGS_NS}tab`, "tools"));
    await reported(draw, "✓ effect refresh");

    const events = await renderLines(env, SID, drawn);
    const motion = events.map((l) => l.match(/ motion=(\S+) /)?.[1]);
    expect(motion[0]).toBe("moves");
    expect(motion).toContain("can-move");
    // The render event says how long a drawn menu has sat idle, of its timeout.
    const menuIdle = events.map((l) => l.match(/ menuIdle=(\S+) /)?.[1]);
    expect(menuIdle[0]).toBe("-");
    expect(menuIdle).toContainEqual(expect.stringMatching(/^\d+\.\ds\/120s$/));
    expect(motion).toContain("still");
    // Each run's report is noted on the record of the turn that took its
    // reading.
    const doctorLines = (lines: readonly string[]) =>
      lines.filter((l) => {
        const fields = fieldsOf(l);
        return fields.has("doctor") && fields.get("sid") === SID;
      });
    expect(
      (
        await loggedLines(
          env,
          doctorLines,
          (found) => found.length >= 4,
          "the doctor's four runs",
        )
      ).map((l) => fieldsOf(l).get("frames")),
      // The third run's still bar sits under a menu counting down to its
      // close, which moves it; the fourth's menu is closed.
    ).toEqual(["1/0/0/0/0", "1/0/0/0/0", "1/0/0/0/0", "0/0/1/0/0"]);
  } finally {
    await daemon.stop();
    removeTmpDirs();
  }
});
