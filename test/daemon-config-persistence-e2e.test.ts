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
//
// [LAW:verifiable-goals] candybar-settings-ui-aok.3 folded the two controls
// per setting into ONE whose destination the `persist?` checkbox chooses, so
// this test now drives that choice over the real socket: the SAME rendered
// theme control emits a session `set-state` write with persist? unchecked and
// a durable `set-config` write with it checked. That contrast is the ticket's
// headline claim, and asserting it on the wire — not on the compiled action —
// is what proves the destination really rides the click.

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { effectsOf } from "./helpers/click";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  click,
  extractUrls,
  findUrl,
  killAndWait,
  render,
  renderUntil,
} from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

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

      // The settings menu and its config row are collapsed by default — open
      // both, the same two clicks a "☰ ▸" then "⚙ config ▸" tap dispatches.
      // The disclosure contract (write the disclosure's own name to its own
      // key) is stable synthesis, not render output, so constructing it
      // directly matches test/default-dsl-config.test.ts's own precedent
      // rather than depending on extracting it.
      await click(
        sockPath,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [SID, "settings.menu", "open"] },
          { verb: VERB_SET_STATE, args: [SID, "settings.config", "open"] },
        ]),
      );

      const menuOpen = await render(sockPath, SID, projectDir);

      // The config row reveals the theme control's TRIGGER (▸), not the
      // picker body — {{ menu }} is its own nested disclosure. Click ITS
      // toggle (a set-state write under the reserved menus.* namespace, whose
      // member is the apply action's name) before any per-theme option link
      // exists to click.
      const themeMenuToggleUrl = findUrl(extractUrls(menuOpen), (effects) =>
        effects.length === 1 &&
        effects[0]!.verb === "set-state" &&
        effects[0]!.args[2] === "settings.apply.theme",
      );
      expect(themeMenuToggleUrl).toBeDefined();
      await click(sockPath, themeMenuToggleUrl!);

      // TWO themes, deliberately: one tried in-session and one committed
      // durably. Using the same name for both would let the session pick
      // satisfy the durability assertions below (a session value wins for its
      // own session), so the test would pass with the durable write missing.
      const [sessionTheme, targetTheme] = listResolvablePaletteNames().filter(
        (name) => name !== "tokyo-night", // the bundled default's globals.palette
      );
      if (sessionTheme === undefined || targetTheme === undefined) {
        throw new Error(
          "listResolvablePaletteNames() returned fewer than two themes besides " +
            "the bundled default's own palette — need one to try and one to commit",
        );
      }

      // ── persist? UNCHECKED: the one theme control writes the SESSION key.
      // The checkbox starts unchecked (its state var's default), so this is
      // the state a user arrives in — experimentation, costing nothing.
      const sessionOnly = await render(sockPath, SID, projectDir);
      const sessionThemeUrl = findUrl(extractUrls(sessionOnly), (effects) =>
        effects[0]!.verb === "set-state" &&
        effects[0]!.args[1] === "theme" &&
        effects[0]!.args[2] === sessionTheme,
      );
      expect(sessionThemeUrl).toBeDefined();
      // …and emits NO durable write at all while unchecked: not a second
      // effect on the same link, and not a second link elsewhere in the row.
      expect(
        findUrl(extractUrls(sessionOnly), (effects) =>
          effects.some((e) => e.verb === "set-config" && e.args[1] === "palette"),
        ),
      ).toBeUndefined();

      // Take the unchecked click, then read a CONCURRENT session over the same
      // socket: the picker changed this conversation and left the other one
      // alone. That contrast is what "only this session" means, and only a
      // second live session can show it — the overrides file being empty
      // proves nothing about what another session renders.
      await click(sockPath, sessionThemeUrl!);
      const OTHER_SID = "e2e-session-concurrent";
      expect(await render(sockPath, SID, projectDir)).toContain(sessionTheme);
      expect(await render(sockPath, OTHER_SID, projectDir)).not.toContain(
        sessionTheme,
      );

      // Re-open the theme picker: the pick above closed it (closeOnPick).
      await click(sockPath, themeMenuToggleUrl!);

      // ── Check persist?. One click on the checkbox, nothing else about the
      // control changes — same segment, same picker, same options.
      const persistToggleUrl = findUrl(extractUrls(await render(sockPath, SID, projectDir)), (effects) =>
        effects.length === 1 &&
        effects[0]!.verb === "set-state" &&
        effects[0]!.args[1] === "settings.persist" &&
        effects[0]!.args[2] === "true",
      );
      expect(persistToggleUrl).toBeDefined();
      await click(sockPath, persistToggleUrl!);

      const opened = await render(sockPath, SID, projectDir);
      const openedUrls = extractUrls(opened);

      // ── persist? CHECKED: the SAME control now writes the durable key.
      // (set-config on the globals field `palette`, not set-state on the
      // session key `theme` — one control, the destination chosen by a value.)
      const themeForeverUrl = findUrl(openedUrls, (effects) =>
        effects[0]!.verb === "set-config" &&
        effects[0]!.args[1] === "palette" &&
        effects[0]!.args[2] === targetTheme,
      );
      expect(themeForeverUrl).toBeDefined();
      expect(
        findUrl(openedUrls, (effects) =>
          effects.some((e) => e.verb === "set-state" && e.args[1] === "theme"),
        ),
      ).toBeUndefined();

      // The session pick from before is untouched by checking the box —
      // toggling persist? moves where the NEXT write goes, never values
      // already written.
      expect(await render(sockPath, SID, projectDir)).toContain(sessionTheme);

      // The padding stepper's ▶ is a bounded step over the same durable
      // field while persist? is checked (render/action.ts's persist-bounded
      // arm: args = [sessionId, key, String(by)]) — find the one whose `by`
      // is positive, so the assertion below is pinned to the actual
      // increment, not whichever stepper happens to render first.
      const paddingUpUrl = findUrl(openedUrls, (effects) =>
        effects.length === 1 &&
        effects[0]!.verb === "step-config" &&
        effects[0]!.args[1] === "padding" &&
        Number(effects[0]!.args[2]) > 0,
      );
      expect(paddingUpUrl).toBeDefined();

      await click(sockPath, themeForeverUrl!);
      await click(sockPath, paddingUpUrl!);

      // Live, no daemon restart: the persisted write rides the config file's
      // own watcher (RenderCache), so it is visible to a running daemon before
      // any restart. Read it on the CONCURRENT session, which never picked a
      // theme — the clicking session cannot show this, because its own session
      // pick outranks a durable default for its own render (bundled default <
      // config file < persisted overrides < preset < session pick). Asserting
      // durability there would conflate the two layers and pass on the session
      // value alone.
      // Its menu is closed — both disclosure keys are SessionState, so this
      // session opens collapsed however many themes another session persists.
      // The theme NAME only renders inside the config row, so open it (a pure
      // UI affordance, not a config mutation) before reading the value.
      await click(
        sockPath,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [OTHER_SID, "settings.menu", "open"] },
          { verb: VERB_SET_STATE, args: [OTHER_SID, "settings.config", "open"] },
        ]),
      );
      const afterClicks = await renderUntil(
        sockPath,
        OTHER_SID,
        projectDir,
        (out) => out.includes(targetTheme),
        `the persisted theme "${targetTheme}" on a session that never picked one`,
      );
      expect(afterClicks).toContain(targetTheme);

      // …and the clicking session still shows ITS pick, which is that same
      // precedence read from the other end.
      expect(await render(sockPath, SID, projectDir)).toContain(sessionTheme);

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
      // render already carries), but the THEME NAME text only appears in the
      // settings menu's config row — collapsed by default per-session, since
      // both disclosure keys are SessionState, not something a config write
      // touches. Open them for this fresh session (a pure UI affordance, not
      // a config mutation) to assert the persisted name shows up with zero
      // prior clicks by THIS session, i.e. it came from the config default,
      // not a picked-and-remembered value. Note this fresh session's own
      // persist? checkbox is UNCHECKED — a checkbox armed in one session
      // never carries into another.
      const FRESH_SID = "e2e-session-2-fresh";
      await render(sockPath, FRESH_SID, projectDir);
      await click(
        sockPath,
        effectsUrl([
          { verb: VERB_SET_STATE, args: [FRESH_SID, "settings.menu", "open"] },
          { verb: VERB_SET_STATE, args: [FRESH_SID, "settings.config", "open"] },
        ]),
      );
      const freshOut = await renderUntil(
        sockPath,
        FRESH_SID,
        projectDir,
        (out) => out.includes(targetTheme),
        `the persisted theme "${targetTheme}" for a fresh session`,
      );
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
