// [LAW:verifiable-goals] candybar-settings-ui-aok.1's headline acceptance,
// measured the only way the ticket accepts: from a USER CONFIG FILE whose
// `root` is a single row of two segments, resolved by a REAL daemon over a
// REAL socket. That is the shape that broke — `root` replaces the bundled
// default's wholesale, and the maintainer's own config is exactly this shape,
// which is why presets, edit mode, and the eight value controls were
// unreachable for the person they were built for.
//
// The in-process suite (test/settings-menu.test.ts) proves the synthesis. This
// one proves the thing the epic actually claims: that a user who writes a
// `root:` still has a door. Config resolution happens DAEMON-side, so the
// isolated `XDG_CONFIG_HOME` must be the daemon's — a client-side override
// would resolve nothing.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import { parseHandlerUrl } from "../src/install/index";
import { effectsOf } from "./helpers/click";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { sendDaemonRequest, waitForExit } from "./helpers/daemon-wire";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { EDIT_MODE_KEY } from "../src/config/loader/edit-mode";

jest.setTimeout(30_000);

const REPLY_BUDGET_MS = 5000;
// Same documented transient-retry contract daemon-config-persistence-e2e uses:
// a cold first render (git spawn + config parse + template compile) can exceed
// the daemon's 200ms per-request guard on a loaded runner.
const TIMEOUT_RETRY_BUDGET = 5;

async function render(
  sockPath: string,
  sessionId: string,
  cwd: string,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const resp = await sendDaemonRequest(
      sockPath,
      {
        v: PROTOCOL_VERSION,
        kind: "render",
        hookData: {
          hook_event_name: "Status",
          session_id: sessionId,
          transcript_path: path.join(cwd, "transcript.jsonl"),
          cwd,
          model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
          workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
        },
        args: [],
        cwd,
      },
      REPLY_BUDGET_MS,
    );
    if (!resp.ok) {
      if (resp.code === "TIMEOUT" && attempt < TIMEOUT_RETRY_BUDGET) continue;
      throw new Error(`render failed: ${resp.error} (${resp.code})`);
    }
    if (!("output" in resp)) {
      throw new Error(`render carried no output: ${JSON.stringify(resp)}`);
    }
    return resp.output;
  }
}

async function click(sockPath: string, url: string): Promise<void> {
  const { verb, value } = parseHandlerUrl(url);
  const resp = await sendDaemonRequest(
    sockPath,
    { v: PROTOCOL_VERSION, kind: "click", verb, value },
    REPLY_BUDGET_MS,
  );
  if (!resp.ok) {
    throw new Error(`click failed: ${resp.error} (${resp.code})`);
  }
}

function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

// The affordance that writes `value` to `key`, as the user's own click would
// find it: by what it does, from the rendered bytes — never constructed.
function urlWriting(rendered: string, key: string, value: string): string {
  const url = extractUrls(rendered).find((u) => {
    try {
      return effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value);
    } catch {
      return false;
    }
  });
  if (url === undefined) {
    throw new Error(`no rendered affordance writes ${key}=${value}`);
  }
  return url;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

async function killAndWait(daemon: RunningDaemon): Promise<void> {
  const exited = waitForExit(daemon.child);
  daemon.killTree();
  await exited;
}

describe("candybar-settings-ui-aok.1: real daemon, real user config", () => {
  test("a user root of one row of two segments still reaches presets and edit mode", async () => {
    const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-settings-e2e",
    );
    // The acceptance config, written where the DAEMON resolves it.
    const configDir = path.join(env.XDG_CONFIG_HOME!, "cc-candybar");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "config.json5"),
      JSON.stringify({ root: { h: ["directory", "model"] } }),
    );
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-settings-e2e-project-"),
    );

    let daemon: RunningDaemon | undefined;
    try {
      daemon = await spawnDaemonWithEnv(env);
      const SID = "settings-e2e-1";

      // 1. The door exists, from a config that declared only two segments.
      const closed = await render(sockPath, SID, projectDir);
      expect(stripAnsi(closed)).toContain("☰ ▸");
      expect(stripAnsi(closed)).not.toContain("✎ edit");

      // 2. Its click opens the body — found in the rendered bytes and
      //    dispatched through the real click gate, so a menu the derived
      //    validators did not admit would fail here rather than no-op.
      await click(sockPath, urlWriting(closed, SETTINGS_ANCHOR, "open"));
      const opened = stripAnsi(await render(sockPath, SID, projectDir));
      expect(opened).toContain("☰ ▾");
      expect(opened).toContain("✎ edit"); // edit mode
      expect(opened).toContain("▦"); // preset switching

      // 3. Edit mode is genuinely entered from here — the route that used to
      //    exist only through the `toolbar` segment this user's root drops.
      const bodyOut = await render(sockPath, SID, projectDir);
      await click(sockPath, urlWriting(bodyOut, EDIT_MODE_KEY, "open"));
      const editing = await render(sockPath, SID, projectDir);
      expect(stripAnsi(editing)).toContain("✎ done");
      expect(
        extractUrls(editing).filter((u) => u.includes("apply-layout-op")).length,
      ).toBeGreaterThan(0);
    } finally {
      if (daemon) await killAndWait(daemon);
      removeTmpDirs();
    }
  });
});
