// [LAW:verifiable-goals] A config that cannot be drawn as written, measured on
// the daemon's own request handling. A config that fails to load draws the
// bundled default with its settings menu and, beside the door, the indicator;
// its error is read in full in the viewer, never in a strip above the bar. A
// config that places a segment nothing declares draws everything else it
// placed, and the one bad placement is its error.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { RichText } from "@promptctl/rich-js";
import {
  click,
  linkUrls,
  render,
  stripAnsi,
  urlWriting,
} from "./helpers/daemon-e2e";
import { startDaemon, type InWorkerDaemon } from "./helpers/in-worker-daemon";
import {
  prepareIsolatedDaemonEnv,
} from "./helpers/spawn-isolated-daemon";
import {
  indicatorOf,
  pageOf,
  readDiagnostics,
  viewerLink,
} from "./helpers/diagnostics-viewer";
import { effectsOf } from "./helpers/click";
import { renderLines } from "./helpers/daemon-log";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { DOOR_CLOSE_GLYPH, DOOR_GLYPH } from "../src/config/disclosure";

jest.setTimeout(30_000);

describe("a config that cannot be drawn as written", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let daemon: InWorkerDaemon;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-broken-e2e");
    ({ env, removeTmpDirs } = prepared);
    mkdirSync(path.join(env.XDG_CONFIG_HOME!, "cc-candybar"), {
      recursive: true,
    });
    projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-broken-e2e-project-"),
    );
    daemon = startDaemon(env);
  });

  afterAll(async () => {
    await daemon?.stop();
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  // Each case writes its own file and renders it under its own session.
  const args = (name: string, text: string): string[] => {
    const file = path.join(projectDir, `${name}.json5`);
    writeFileSync(file, text);
    return ["cc-candybar", "--config", file];
  };

  test("a config that will not parse draws the bundled default and the indicator; the viewer shows its error in full", async () => {
    const sid = "broken-parse";
    const a = args("unparsable", `{ root: { h: ["directory"] `);
    const bar = await render(daemon, sid, projectDir, {}, a);
    const text = stripAnsi(bar);
    // The bundled default with its door, the indicator beside it, no strip.
    expect(text).toContain(DOOR_GLYPH);
    expect(indicatorOf(bar)).toBe("⚠ 1");
    expect(text).not.toContain("unparsable.json5");
    expect(text.indexOf("⚠ 1")).toBeGreaterThan(text.indexOf(DOOR_GLYPH));

    const pages = await readDiagnostics(daemon, sid, projectDir, bar, {}, a);
    expect(pages.map((p) => p.position)).toEqual(["1/1"]);
    expect(pages[0]!.text).toContain("unparsable.json5");
    // The viewer takes the body's place: the bar's door is not drawn under it.
    expect(stripAnsi(pages[0]!.rendered)).not.toContain(DOOR_GLYPH);
    // ✕ brought the bar back.
    expect(indicatorOf(await render(daemon, sid, projectDir, {}, a))).toBe(
      "⚠ 1",
    );
  });

  // The viewer holds the message it was opened on, not a position: a message
  // arriving ahead of it leaves it in view, and once it is gone the viewer
  // closes, and stays closed when other messages appear later.
  test("the viewer follows its message as the list moves, and closes once it is gone", async () => {
    const sid = "broken-identity";
    const a = args(
      "identity",
      `{ globals: { padding: 1, padding: 1 }, segments: { mine: { template: "MINE" } }, root: { h: ["mine"] } }`,
    );
    // An unknown flag is this request's own error, ahead of the file's warning.
    const flagged = [...a, "--no-such-flag"];
    const draw = (argv: string[]) =>
      render(daemon, sid, projectDir, {}, argv);
    const bar = await draw(a);
    expect(indicatorOf(bar)).toBe("⚠ 1");
    await click(daemon, viewerLink(bar, "open")!.url);
    let shown = await draw(flagged);
    // The error arrived ahead of it: still the warning, now second.
    expect(pageOf(shown).position).toBe("2/2");
    expect(pageOf(shown).text).toContain('duplicate key "padding"');
    // Paged to the flag's error, which then goes: closed, never the warning.
    await click(daemon, viewerLink(shown, "‹")!.url);
    shown = await draw(flagged);
    expect(pageOf(shown).text).toContain("--no-such-flag");
    shown = await draw(a);
    expect(stripAnsi(shown)).toContain("MINE");
    expect(indicatorOf(shown)).toBe("⚠ 1");
    // Another error arriving later does not open the viewer on it.
    shown = await draw([...a, "--another-flag"]);
    expect(stripAnsi(shown)).toContain("MINE");
    expect(indicatorOf(shown)).toBe("⚠ 2");
  });

  test("a config failing validation keeps a working bar: the default's settings menu opens under its error", async () => {
    const sid = "broken-validate";
    const a = args(
      "invalid",
      JSON.stringify({
        actions: { applyTheme: { set: "theme", from: "themes" } },
        segments: {
          t: {
            template: '{{ menu "applyTheme" }}',
            bg: "surface",
            fg: "foreground",
          },
        },
        root: { h: ["t"] },
      }),
    );
    const bar = await render(daemon, sid, projectDir, {}, a);
    expect(indicatorOf(bar)).toBe("⚠ 1");
    await click(daemon, urlWriting(bar, SETTINGS_ANCHOR, "open"));
    const opened = await render(daemon, sid, projectDir, {}, a);
    expect(stripAnsi(opened)).toContain(DOOR_CLOSE_GLYPH);
    expect(stripAnsi(opened)).toContain("▦"); // preset switching is reachable
    expect(indicatorOf(opened)).toBe("⚠ 1"); // still loud
    const [page] = await readDiagnostics(
      daemon,
      sid,
      projectDir,
      opened,
      {},
      a,
    );
    expect(page!.text).toContain("trigger needs a display");
  });

  test("a placement of an undeclared segment drops only its own cell", async () => {
    const sid = "broken-unknown";
    const a = args(
      "unknown",
      `{ segments: { mine: { template: "MINE" }, also: { template: "ALSO" } }, root: { h: ["mine", "nosuchseg", "also"] } }`,
    );
    const bar = await render(daemon, sid, projectDir, {}, a);
    const text = stripAnsi(bar);
    expect(text).toContain("MINE");
    expect(text).toContain("ALSO");
    expect(indicatorOf(bar)).toBe("⚠ 1");
    expect(text).not.toContain("does not match");
    const pages = await readDiagnostics(daemon, sid, projectDir, bar, {}, a);
    expect(pages.map((p) => p.text)).toEqual([
      expect.stringMatching(/"nosuchseg" does not match any declared segment/),
    ]);
    // [LAW:nothing-unseen] The render event counts what the indicator showed,
    // and names the message the viewer showed while it was open.
    const events = await renderLines(env, sid, 2);
    expect(
      events.some((e) => / diag=1 /.test(e) && / viewer=1\/1p1( |$)/.test(e)),
    ).toBe(true);
    expect(events.at(0)).toMatch(/ viewer=-( |$)/);
  });

  test("the viewer wraps one message at the client's width; › and ‹ page; ⧉ copies the prompt that fixes the message it shows; an absent plugin's cell adds nothing", async () => {
    const sid = "broken-many";
    const hints = { termCols: 40 };
    const a = args(
      "many",
      `{ globals: { padding: 1, padding: 1 }, segments: { mine: { template: "MINE" } }, root: { h: ["mine", "first-missing-segment", "repo.lit.ticket", "second-missing"] } }`,
    );
    const bar = await render(daemon, sid, projectDir, hints, a);
    // One error (both drops, one load's) and one warning (the duplicate key):
    // red, since one is an error. The cell of a plugin absent here adds
    // nothing to either.
    expect(indicatorOf(bar)).toBe("⚠ 2");
    const pages = await readDiagnostics(
      daemon,
      sid,
      projectDir,
      bar,
      hints,
      a,
    );
    expect(pages.map((p) => p.position)).toEqual(["1/2", "2/2"]);
    expect(pages[0]!.text).toContain("first-missing-segment");
    expect(pages[0]!.text).toContain("second-missing");
    expect(pages[0]!.text).not.toContain("duplicate key");
    expect(pages.map((p) => p.text).join("\n")).not.toContain("repo.lit");
    expect(pages[1]!.text).toContain('duplicate key "padding"');
    for (const page of pages)
      for (const row of stripAnsi(page.rendered).trimEnd().split("\n"))
        expect(new RichText(row).cellLength).toBeLessThanOrEqual(40);

    // ‹ steps back from the second message to the first.
    await click(daemon, viewerLink(bar, "open")!.url);
    let shown = await render(daemon, sid, projectDir, hints, a);
    await click(daemon, viewerLink(shown, "›")!.url);
    shown = await render(daemon, sid, projectDir, hints, a);
    expect(pageOf(shown).position).toBe("2/2");
    await click(daemon, viewerLink(shown, "‹")!.url);
    shown = await render(daemon, sid, projectDir, hints, a);
    expect(pageOf(shown).position).toBe("1/2");
    const copyUrls = linkUrls(shown).filter((u) =>
      effectsOf(u).some((e) => e.verb.startsWith("copy")),
    );
    const copies = copyUrls.flatMap((u) => effectsOf(u));
    // ⧉ and the message's first line both name the message by its key; the
    // daemon reads the prompt that fixes it when the click runs, so no link
    // carries it and the frame's bytes do not grow with it.
    expect(copies.length).toBeGreaterThan(1);
    for (const c of copies)
      expect(c).toEqual({
        verb: "copy-diagnostic",
        args: [sid, "request", expect.any(String)],
      });
    for (const c of copies) expect(c.args).toEqual(copies[0]!.args);
    for (const u of copyUrls) expect(u.length).toBeLessThan(200);
    expect(shown).not.toContain("Fix my cc-candybar");
    // A key no draw lists (the message fixed since) is refused loudly.
    await expect(
      click(daemon, copyUrls[0]!.replace(String(copies[0]!.args[2]), "1")),
    ).rejects.toThrow(/no longer listed/);
    await click(daemon, viewerLink(shown, "✕")!.url);
  });
});
