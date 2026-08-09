// [LAW:verifiable-goals] candybar-config-engine-71o.5's headline acceptance:
// the epic's claim ("mutate the configuration via the menu system,
// durably") is a COMPOSITION property — click, gate, persistent write,
// watcher reload, re-render, daemon restart, fresh session — and every
// sibling ticket (.1-.4) proved its own slice against an in-process rig,
// never the composition against a REAL daemon over a REAL socket. This file
// drives the actual `cc-candybar daemon` subprocess exactly as a real
// client would: render → extract the rendered OSC-8 URLs → parseHandlerUrl
// (the same decode `cc-candybar url-handle` runs) → send verb+value as a
// "click" wire request → render again.
//
// Uses the BUNDLED DEFAULT (DEFAULT_DSL_CONFIG) with no hand-authored
// actions — the epic's own acceptance bullet is specifically "a user
// running the bundled default... can change (at least) default theme...
// and padding... each change survives daemon restart" — plus one minimal
// hand-authored user config file, present only to prove the daemon never
// writes to it (persistent writes land in the daemon-owned overrides layer,
// never the config file on disk).

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

// [LAW:no-ambient-temporal-coupling] `TIMEOUT` (server.ts's REQUEST_TIMEOUT_MS
// — a real 200ms per-request guard protecting the daemon from one slow
// request blocking every other connection) is classified `transient` by the
// real client (client-transport.ts's interpretResponse): the daemon is up,
// just slow for this one request, and the documented recovery is retry, not
// fail. A cold first render for a brand-new (projectDir, cwd) — first git
// subprocess spawn, first config parse + template compile — can genuinely
// exceed 200ms on a loaded CI runner even though it's fast on a warm local
// machine. A real client shows a blank line and lets the next natural
// render tick retry; this test has no "next tick" to lean on, so it retries
// inline, bounded, matching the documented transient contract rather than
// treating an expected-occasionally condition as a hard failure.
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

describe("candybar-config-engine-71o.5: real-daemon click → persist → restart", () => {
  test("bundled default: clicking theme + padding forever, over the real socket, survives a cold daemon restart and a byte-identical config file", async () => {
    const { env, sockPath, stateDir, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-config-e2e",
    );
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-config-e2e-project-"),
    );
    const userConfigPath = path.join(projectDir, ".cc-candybar.json5");
    // No hand-authored actions — proves the epic acceptance bullet against
    // the BUNDLED DEFAULT, not a config built to exercise the mechanism.
    const userConfigBody = JSON.stringify({ globals: {}, segments: {} });
    writeFileSync(userConfigPath, userConfigBody);

    let daemon: RunningDaemon | undefined;
    try {
      daemon = await spawnDaemonWithEnv(env);
      const SID = "e2e-session-1";

      // A render warms the daemon's per-(projectDir,cwd) cache entry, which
      // is what derives and registers the click gates (deriveActionValidators
      // / deriveConfigActionValidators) — a click before the first render
      // for this project has no gate to pass yet.
      await render(sockPath, SID, projectDir);

      // The settingsDrawer's controls are collapsed by default (candybar-
      // config-engine-71o.4) — open it first, the same click a "⚙ settings
      // ▸" tap dispatches. The group-toggle contract (write "groups.<name>"
      // to the group's own name) is stable synthesis, not render output, so
      // constructing it directly matches test/default-dsl-config.test.ts's
      // own theming-8uj.1 precedent rather than depending on extracting it.
      await click(
        sockPath,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [SID, "groups.settings", "settings"] },
        ]),
      );

      const drawerOpen = await render(sockPath, SID, projectDir);
      const drawerOpenUrls = extractUrls(drawerOpen);

      // Opening the drawer reveals themeControl's TRIGGER (the 📌 glyph),
      // not applyThemeForever's own picker body — {{ menu }} is its own
      // nested disclosure. Find and click ITS toggle (a set-state write
      // under the reserved menus.* namespace) before the per-theme option
      // links exist to click.
      const themeForeverToggleUrl = drawerOpenUrls.find((u) => {
        try {
          const effects = effectsOf(u);
          return (
            effects.length === 1 &&
            effects[0]!.verb === "set-state" &&
            effects[0]!.args[2] === "applyThemeForever"
          );
        } catch {
          return false;
        }
      });
      expect(themeForeverToggleUrl).toBeDefined();
      await click(sockPath, themeForeverToggleUrl!);

      const opened = await render(sockPath, SID, projectDir);
      const openedUrls = extractUrls(opened);

      const targetTheme = listResolvablePaletteNames().find(
        (name) => name !== "tokyo-night", // the bundled default's globals.palette
      );
      if (targetTheme === undefined) {
        throw new Error(
          "listResolvablePaletteNames() returned only the bundled default's " +
            "own palette — need at least one other resolvable theme",
        );
      }

      // applyThemeForever is a persist-option action (verb set-config,
      // args = [sessionId, "palette", value]) rendered as one link per
      // theme name — find the one bound to targetTheme specifically, not
      // applyTheme's session-preview twin (verb set-state, key "theme").
      const themeForeverUrl = openedUrls.find((u) => {
        try {
          const effects = effectsOf(u);
          return (
            effects.length === 1 &&
            effects[0]!.verb === "set-config" &&
            effects[0]!.args[1] === "palette" &&
            effects[0]!.args[2] === targetTheme
          );
        } catch {
          return false;
        }
      });
      expect(themeForeverUrl).toBeDefined();

      // paddingUpForever and paddingDownForever are both persist-bounded
      // steppers over the SAME "padding" field, distinguished only by their
      // signed `by` (render/action.ts's persist-bounded arm: args =
      // [sessionId, key, String(by)]) — find the one whose `by` is
      // positive, so the assertion below is pinned to the actual increment,
      // not whichever stepper happens to render first.
      const paddingUpUrl = openedUrls.find((u) => {
        try {
          const effects = effectsOf(u);
          return (
            effects.length === 1 &&
            effects[0]!.verb === "step-config" &&
            effects[0]!.args[1] === "padding" &&
            Number(effects[0]!.args[2]) > 0
          );
        } catch {
          return false;
        }
      });
      expect(paddingUpUrl).toBeDefined();

      await click(sockPath, themeForeverUrl!);
      await click(sockPath, paddingUpUrl!);

      // Live re-render, same session, no daemon restart: the persisted
      // overrides ride the config file's own watcher (RenderCache), so this
      // proves the write took effect without a restart, before proving it
      // SURVIVES one below.
      const afterClicks = await render(sockPath, SID, projectDir);
      expect(afterClicks).toContain(targetTheme);

      // The hand-authored file is byte-identical — persist never touches it.
      expect(readFileSync(userConfigPath, "utf8")).toBe(userConfigBody);

      const overridesPath = path.join(
        stateDir,
        "config-overrides.json",
      );
      const overrides = JSON.parse(readFileSync(overridesPath, "utf8")) as {
        palette?: string;
        padding?: number;
      };
      expect(overrides.palette).toBe(targetTheme);
      // clampSeed's documented fallback (validator-registry.ts): an unset
      // seed falls back to `min` (0), not the bundled default's rendered
      // padding — the bundled default never literally sets
      // `globals.padding` (it relies on the render-side `?? 1` floor), so
      // configKeySeeds has nothing numeric to seed from. First click from
      // an empty overrides file is therefore min(0) + by(1) = 1.
      expect(overrides.padding).toBe(1);

      // Kill this daemon and start a FRESH one against the SAME state dir
      // (same overrides file) — a real cold restart, not an in-process
      // cache rebuild.
      await killAndWait(daemon);
      daemon = await spawnDaemonWithEnv(env);

      // A brand-new session that never clicked anything. The persisted
      // theme is now every session's baseline PALETTE (colors the fresh
      // render already carries), but the THEME NAME text only appears
      // inside the settingsDrawer — collapsed by default per-session, since
      // groups.settings is itself SessionState, not something a config
      // write touches. Open the drawer for this fresh session (a pure UI
      // affordance, not a config mutation) to assert the persisted name
      // shows up with zero prior clicks by THIS session, i.e. it came from
      // the config default, not a picked-and-remembered value.
      const FRESH_SID = "e2e-session-2-fresh";
      await render(sockPath, FRESH_SID, projectDir);
      await click(
        sockPath,
        effectsUrl([
          {
            verb: VERB_SET_STATE,
            args: [FRESH_SID, "groups.settings", "settings"],
          },
        ]),
      );
      const freshOut = await render(sockPath, FRESH_SID, projectDir);
      expect(freshOut).toContain(targetTheme);

      // The hand-authored file is STILL byte-identical after the restart.
      expect(readFileSync(userConfigPath, "utf8")).toBe(userConfigBody);
    } finally {
      if (daemon) daemon.killTree();
      removeTmpDirs();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
