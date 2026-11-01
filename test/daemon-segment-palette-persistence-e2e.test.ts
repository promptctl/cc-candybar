// [LAW:verifiable-goals] candybar-config-engine-71o.6's own acceptance,
// proven the SAME way 71o.5 proved the epic's headline composition (click,
// gate, persistent write, watcher reload, re-render, daemon restart, fresh
// session) — but over `segments.directory.palette` instead of a Globals
// field, against the daemon's own request handling:
// "a user picks a different bundled palette for one specific segment via a
// menu; the choice persists across a daemon restart and appears in new
// sessions, and every other segment's palette is unaffected." The bundled
// default no longer carries a control for it (brandon-menu-ia-q30.42a deleted
// the drawer's directory pin — nothing else in the settings menu is
// per-segment), so the menu here is the user's own: one `{ persist, from }`
// action over the segment key, the same seam any config can author.

import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";
import { effectsOf } from "./helpers/click";
import { linkUrls } from "./helpers/frame";
import { ansiOf, plainOf, type Frame, type Run } from "../src/render/frame";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { startDaemon } from "./helpers/in-worker-daemon";
import {
  prepareIsolatedDaemonEnv,
} from "./helpers/spawn-isolated-daemon";
// [LAW:one-source-of-truth] The shared transient contract: a render retried
// on TIMEOUT and on an answer that drew a source pending.
// [LAW:no-ambient-temporal-coupling] A persist's synchronous write completing
// does not mean the render cache has reloaded (that is a separate fs.watch
// callback), so the wait for a click's effect is the shared render-until,
// which carries the reason.
import { click, render, renderUntil } from "./helpers/daemon-e2e";

jest.setTimeout(30_000);

describe("candybar-config-engine-71o.6: a daemon's segment-palette click → persist → restart", () => {
  test("a user's directory-palette menu, clicked, survives a cold restart and leaves every other segment's palette untouched", async () => {
    const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-seg-palette-e2e",
    );
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-seg-palette-e2e-project-"),
    );
    // The user's own file — the one durable clicks write.
    const userConfigPath = path.join(
      env.XDG_CONFIG_HOME!,
      "cc-candybar",
      "config.json5",
    );
    mkdirSync(path.dirname(userConfigPath), { recursive: true });
    const control = {
      template: '🎨 directory {{ menu "applyDirectoryPalette" "▸" "▾" }}',
    };
    const userConfigBody = JSON.stringify({
      globals: {},
      actions: {
        applyDirectoryPalette: {
          persist: "segments.directory.palette",
          from: "themes",
        },
      },
      segments: { directoryPaletteControl: control },
      root: { rows: { palettes: { h: ["directoryPaletteControl"] } } },
    });
    writeFileSync(userConfigPath, userConfigBody);

    let daemon = startDaemon(env);
    try {
      const SID = "seg-e2e-session-1";

      // Warm the cache entry (derives + registers the click gates) before
      // the baseline render this test diffs against.
      const before = await render(daemon, SID, projectDir);
      // The status row (model/context/cacheTimer/block/weekly) never reads
      // `directory`'s palette — the untouched baseline every "other segment
      // unaffected" assertion below compares against. The rows stack
      // identity, status, then the control's own row, whose open menu drops a
      // line beneath it; the status row is the one line no click here moves,
      // so it is found by content rather than by index. Its links are dropped:
      // a control's link names the session it was rendered for, and the fresh
      // session below is a different one — the colours are what must match.
      const statusRow = (out: Frame): Omit<Run, "link">[] | undefined =>
        out.rows
          .find(({ runs }) => plainOf(runs).includes("Opus 4.7"))
          ?.runs.map(({ link: _, ...look }) => look);
      const statusRowBefore = statusRow(before);
      expect(statusRowBefore).toBeDefined();

      // The menu's own toggle, before its per-theme option links exist to
      // click.
      const menuToggleUrl = linkUrls(before).find((u) => {
        try {
          const effects = effectsOf(u);
          return (
            effects.length === 1 &&
            effects[0]!.verb === "set-state" &&
            effects[0]!.args[2] === "applyDirectoryPalette"
          );
        } catch {
          return false;
        }
      });
      expect(menuToggleUrl).toBeDefined();
      await click(daemon, menuToggleUrl!);

      const opened = await render(daemon, SID, projectDir);
      const openedUrls = linkUrls(opened);

      const targetPalette = listResolvablePaletteNames().find(
        (name) => name !== "tokyo-night", // the bundled default's globals.palette
      );
      if (targetPalette === undefined) {
        throw new Error(
          "listResolvablePaletteNames() returned only the bundled default's " +
            "own palette — need at least one other resolvable theme",
        );
      }

      // applyDirectoryPalette is a persist-option action targeting
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

      await click(daemon, applyUrl!);

      // Live re-render, same session, no daemon restart — the persisted
      // palette rides the config file's own watcher, which reloads
      // asynchronously (so the shared render-until waits). `opened` (captured right
      // after the menu was opened, same menu-open state as the post-click
      // render, but BEFORE the click) is the right baseline for "did the
      // click visibly change anything" — a `before`-vs-post-click diff would
      // be trivially true regardless of the palette, since `before` was
      // rendered with the menu CLOSED. With menu state held constant, this
      // proves the persisted palette actually reached
      // the rendered `directory` segment's colors — not just that the
      // config file was written (asserted below): a broken reload of
      // the file's own declaration would time out here.
      const afterClick = await renderUntil(
        daemon,
        SID,
        projectDir,
        (b) => ansiOf(b) !== ansiOf(opened),
        "a change from the opened render",
        10_000,
      );
      expect(afterClick.rows).not.toEqual(opened.rows);
      // The status row — nothing to do with `directory` — is the same run for
      // run: the override changed exactly one segment's palette, nothing else.
      expect(statusRow(afterClick)).toEqual(statusRowBefore);

      // [LAW:one-source-of-truth] The config FILE is the durable store
      // (candybar-config-dqe). `segments` merge by name then by field, so
      // pinning a palette on a segment the file does not declare writes
      // exactly `directory: { palette }` — a delta over the bundled
      // declaration — beside the file's own control, and nothing else: no
      // template, no globals field, no other segment.
      const written = JSON5.parse(readFileSync(userConfigPath, "utf8")) as {
        globals: Record<string, unknown>;
        segments: Record<string, { template?: string; palette?: string }>;
      };
      expect(written.globals).toEqual({});
      expect(written.segments).toEqual({
        directoryPaletteControl: control,
        directory: { palette: targetPalette },
      });
      const afterFirstWrite = readFileSync(userConfigPath, "utf8");

      // Stop this daemon and build a FRESH one against the SAME config file,
      // the only place a saved value lives.
      await daemon.stop();
      daemon = startDaemon(env);

      // A brand-new session that never clicked anything — the persisted
      // segment palette is baked into the config DEFAULT every session
      // reads, so the status row must be identical to the pre-override
      // baseline for THIS fresh session too (a different session id can
      // shift nothing content-derived, and directory's own row differs by
      // construction — the status row is the untouched control).
      const FRESH_SID = "seg-e2e-session-2-fresh";
      const freshOut = await render(daemon, FRESH_SID, projectDir);
      expect(statusRow(freshOut)).toEqual(statusRowBefore);

      // The file is STILL exactly what the click wrote — a restart reads it,
      // never rewrites it.
      expect(readFileSync(userConfigPath, "utf8")).toBe(afterFirstWrite);
    } finally {
      await daemon.stop();
      removeTmpDirs();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
