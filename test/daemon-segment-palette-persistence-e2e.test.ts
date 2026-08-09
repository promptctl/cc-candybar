// [LAW:verifiable-goals] candybar-config-engine-71o.6's own acceptance,
// proven the SAME way 71o.5 proved the epic's headline composition (click,
// gate, persistent write, watcher reload, re-render, daemon restart, fresh
// session) — but over `segments.directory.palette` instead of a Globals
// field, against a REAL `cc-candybar daemon` subprocess over a REAL socket,
// using the BUNDLED DEFAULT (DEFAULT_DSL_CONFIG) with no hand-authored
// actions: "from the bundled default with no hand-authored actions, a user
// picks a different bundled palette for one specific segment via a menu;
// the choice persists across a daemon restart and appears in new sessions,
// and every other segment's palette is unaffected."

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROTOCOL_VERSION } from "../src/daemon/protocol";
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

// [LAW:no-ambient-temporal-coupling] Same transient-TIMEOUT retry budget
// daemon-config-persistence-e2e.test.ts uses (see its own comment) — a cold
// first render on a loaded CI runner can genuinely exceed the daemon's real
// per-request timeout guard even though it's fast locally.
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

describe("candybar-config-engine-71o.6: real-daemon segment-palette click → persist → restart", () => {
  test("bundled default: clicking directory's palette-forever menu, over the real socket, survives a cold restart and leaves every other segment's palette untouched", async () => {
    const { env, sockPath, stateDir, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-seg-palette-e2e",
    );
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-seg-palette-e2e-project-"),
    );
    const userConfigPath = path.join(projectDir, ".cc-candybar.json5");
    // No hand-authored actions — proves the criterion against the BUNDLED
    // DEFAULT, not a config built to exercise the mechanism.
    const userConfigBody = JSON.stringify({ globals: {}, segments: {} });
    writeFileSync(userConfigPath, userConfigBody);

    let daemon: RunningDaemon | undefined;
    try {
      daemon = await spawnDaemonWithEnv(env);
      const SID = "seg-e2e-session-1";

      // Warm the cache entry (derives + registers the click gates) before
      // the baseline render this test diffs against.
      const before = await render(sockPath, SID, projectDir);
      // The status row (model/context/cacheTimer/block/weekly) never reads
      // `directory`'s palette — the untouched baseline every "other segment
      // unaffected" assertion below compares against. It's always the LAST
      // physical line: `root` vertically STACKS row1 then row2, and row1's
      // OWN line count varies (a {{ menu }}/group drop inserts an extra
      // physical line "immediately below row 1" via FlexStrip's stack-full-
      // width wrap — see src/dsl/render.ts) depending on whether the
      // settingsDrawer is open, so indexing from the end (not a fixed
      // index) stays correct whether the drawer this test opens has landed
      // its extra line yet or not.
      const statusRowBefore = before.split("\n").at(-1);
      expect(statusRowBefore).toBeDefined();

      // Open the settingsDrawer (candybar-config-engine-71o.4's collapsed
      // "⚙ settings ▸" toggle) — directoryPaletteControl lives inside it.
      await click(
        sockPath,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [SID, "groups.settings", "settings"] },
        ]),
      );

      const drawerOpen = await render(sockPath, SID, projectDir);
      const drawerOpenUrls = extractUrls(drawerOpen);

      // directoryPaletteControl's `{{ menu }}` has no shared accordion key
      // (unlike theme/look/style's "pickersForever") — it's an independent
      // disclosure. Find and click its OWN toggle before its per-theme
      // option links exist to click.
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
        (name) => name !== "tokyo-night", // the bundled default's globals.palette
      );
      if (targetPalette === undefined) {
        throw new Error(
          "listResolvablePaletteNames() returned only the bundled default's " +
            "own palette — need at least one other resolvable theme",
        );
      }

      // applyDirectoryPaletteForever is a persist-option action targeting
      // `segments.directory.palette` (verb set-config, args = [sessionId,
      // "segments.directory.palette", value]), rendered as one link per
      // theme name.
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

      // Live re-render, same session, no daemon restart — the persisted
      // override rides the config file's own watcher.
      const afterClick = await render(sockPath, SID, projectDir);
      // The status row — nothing to do with `directory` — is byte-identical:
      // the override changed exactly one segment's palette, nothing else.
      expect(afterClick.split("\n").at(-1)).toBe(statusRowBefore);

      // The hand-authored file is byte-identical — persist never touches it.
      expect(readFileSync(userConfigPath, "utf8")).toBe(userConfigBody);

      const overridesPath = path.join(stateDir, "config-overrides.json");
      const overrides = JSON.parse(readFileSync(overridesPath, "utf8")) as {
        "segments.directory.palette"?: string;
      };
      // Exactly one key was ever persisted by this whole flow — no globals
      // field, no other segment, leaked into the overrides file.
      expect(overrides).toEqual({
        "segments.directory.palette": targetPalette,
      });

      // Kill this daemon and start a FRESH one against the SAME state dir
      // (same overrides file) — a real cold restart, not an in-process
      // cache rebuild.
      await killAndWait(daemon);
      daemon = await spawnDaemonWithEnv(env);

      // A brand-new session that never clicked anything — the persisted
      // segment palette is baked into the config DEFAULT every session
      // reads, so the status row must be identical to the pre-override
      // baseline for THIS fresh session too (a different session id can
      // shift nothing content-derived, and directory's own row differs by
      // construction — the status row is the untouched control).
      const FRESH_SID = "seg-e2e-session-2-fresh";
      const freshOut = await render(sockPath, FRESH_SID, projectDir);
      expect(freshOut.split("\n").at(-1)).toBe(statusRowBefore);

      // The hand-authored file is STILL byte-identical after the restart.
      expect(readFileSync(userConfigPath, "utf8")).toBe(userConfigBody);
    } finally {
      if (daemon) daemon.killTree();
      removeTmpDirs();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
