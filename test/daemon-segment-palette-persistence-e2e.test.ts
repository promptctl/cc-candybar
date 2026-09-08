// [LAW:verifiable-goals] Against a REAL daemon over a REAL socket, from the BUNDLED
// DEFAULT: a per-segment palette persists across a restart and reaches new sessions.

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";
import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { parseHandlerUrl } from "../src/install/index";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { effectsOf } from "./helpers/click";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { sendDaemonRequest, waitForExit } from "./helpers/daemon-wire";

jest.setTimeout(30_000);

const REPLY_BUDGET_MS = 5000;

// [LAW:no-ambient-temporal-coupling] A cold first render on a loaded runner can
// exceed the daemon's per-request timeout guard; retry the transient.
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
      throw new Error(
        `render response carried no output: ${JSON.stringify(resp)}`,
      );
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

async function killAndWait(daemon: RunningDaemon): Promise<void> {
  const exited = waitForExit(daemon.child);
  daemon.killTree();
  await exited;
}

// [LAW:no-ambient-temporal-coupling] A `persist` write completing does NOT mean
// RenderCache reloaded — that is a separate async fs.watch callback, so poll.
async function waitForRenderChange(
  sockPath: string,
  sessionId: string,
  cwd: string,
  baseline: string,
  timeoutMs = 10000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = baseline;
  while (Date.now() < deadline) {
    last = await render(sockPath, sessionId, cwd);
    if (last !== baseline) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `waitForRenderChange: render never changed from baseline within ${timeoutMs}ms`,
  );
}

describe("candybar-config-engine-71o.6: real-daemon segment-palette click → persist → restart", () => {
  test("bundled default: clicking directory's palette-forever menu, over the real socket, survives a cold restart and leaves every other segment's palette untouched", async () => {
    const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-seg-palette-e2e",
    );
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-seg-palette-e2e-project-"),
    );
    const userConfigPath = path.join(projectDir, ".cc-candybar.json5");
    const userConfigBody = JSON.stringify({ globals: {}, segments: {} });
    writeFileSync(userConfigPath, userConfigBody);

    let daemon: RunningDaemon | undefined;
    try {
      daemon = await spawnDaemonWithEnv(env);
      const SID = "seg-e2e-session-1";

      const before = await render(sockPath, SID, projectDir);
      // The status row never reads `directory`'s palette — the untouched control.
      // Always the LAST physical line: row 1's line count varies, so index from end.
      const statusRowBefore = before.split("\n").at(-1);
      expect(statusRowBefore).toBeDefined();

      await click(
        sockPath,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [SID, "groups.settings", "settings"] },
        ]),
      );

      const drawerOpen = await render(sockPath, SID, projectDir);
      const drawerOpenUrls = extractUrls(drawerOpen);

      // This menu has no shared accordion key: click its OWN toggle first.
      const menuToggleUrl = drawerOpenUrls.find((u) => {
        try {
          const effects = effectsOf(u);
          return (
            effects.length === 1 &&
            effects[0]!.verb === "set-state" &&
            effects[0]!.args[2] === "applyDirectoryPaletteForever"
          );
        } catch {
          return false;
        }
      });
      expect(menuToggleUrl).toBeDefined();
      await click(sockPath, menuToggleUrl!);

      const opened = await render(sockPath, SID, projectDir);
      const openedUrls = extractUrls(opened);

      const targetPalette = listResolvablePaletteNames().find(
        (name) => name !== "tokyo-night",
      );
      if (targetPalette === undefined) {
        throw new Error(
          "listResolvablePaletteNames() returned only the bundled default's " +
            "own palette — need at least one other resolvable theme",
        );
      }

      const applyUrl = openedUrls.find((u) => {
        try {
          const effects = effectsOf(u);
          return (
            effects.length === 1 &&
            effects[0]!.verb === "set-config" &&
            effects[0]!.args[1] === "segments.directory.palette" &&
            effects[0]!.args[2] === targetPalette
          );
        } catch {
          return false;
        }
      });
      expect(applyUrl).toBeDefined();

      await click(sockPath, applyUrl!);

      // `opened` is the right baseline: it holds drawer state constant, so a
      // difference can only come from the palette.
      const afterClick = await waitForRenderChange(
        sockPath,
        SID,
        projectDir,
        opened,
      );
      expect(afterClick).not.toBe(opened);
      expect(afterClick.split("\n").at(-1)).toBe(statusRowBefore);

      // [LAW:one-source-of-truth] The config FILE is the durable store, and
      // `segments` merge WHOLESALE — pinning materializes the whole declaration.
      const written = JSON5.parse(readFileSync(userConfigPath, "utf8")) as {
        globals: Record<string, unknown>;
        segments: Record<string, { template?: string; palette?: string }>;
      };
      expect(written.globals).toEqual({});
      expect(Object.keys(written.segments)).toEqual(["directory"]);
      expect(written.segments.directory!.palette).toBe(targetPalette);
      expect(written.segments.directory!.template).toBe(
        DEFAULT_DSL_CONFIG.segments.directory!.template,
      );
      const afterFirstWrite = readFileSync(userConfigPath, "utf8");

      await killAndWait(daemon);
      daemon = await spawnDaemonWithEnv(env);

      // A brand-new session that never clicked: the palette is baked into the default.
      const FRESH_SID = "seg-e2e-session-2-fresh";
      const freshOut = await render(sockPath, FRESH_SID, projectDir);
      expect(freshOut.split("\n").at(-1)).toBe(statusRowBefore);

      expect(readFileSync(userConfigPath, "utf8")).toBe(afterFirstWrite);
    } finally {
      if (daemon) daemon.killTree();
      removeTmpDirs();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
