// [LAW:nothing-unseen] candybar-theme-colours-6fq5.ge6, measured on the
// daemon's own request handling: a render's event — its `render sid=…` log line — names every warning
// that render met, by kind and in order: a config watch that cannot hear
// (`config-watch`), the config load's own (`load`) and each one the render
// itself reported (`RenderWarning`), `-` for none. The table enumerates the
// last two whole — a load warning or not, a render warning or not — and every
// case reads the messages the bar's indicator offers beside the event, so the
// two cannot disagree unseen. A render warning is known only after the
// walk, so the bar counts it from the frame after the one that met it, and a
// renderer records every frame's warnings by value.

import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { render, stripAnsi } from "./helpers/daemon-e2e";
import { indicatorOf, readDiagnostics } from "./helpers/diagnostics-viewer";
import {
  heldClock,
  startDaemon,
  type InWorkerDaemon,
} from "./helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "./helpers/spawn-isolated-daemon";
import { renderLines } from "./helpers/daemon-log";
import { fakeWatches } from "./helpers/fake-watches";
import { untilHeard } from "./helpers/reload-signal";

jest.setTimeout(30_000);

// The rules branch on the session id, payload the daemon carries per render,
// so one config draws a render whose palette rule names no theme, one whose
// style rule throws (brandon-unfiled-3248.2gq), and one that warns of nothing.
const RULE = `{{ if hasSuffix "-bad" .session.id }}no-such-theme{{ else }}dracula{{ end }}`;
const STYLE_RULE = `{{ if hasSuffix "-threw" .session.id }}{{ fail "the rule broke" }}{{ else }}none{{ end }}`;
const GLOBALS = `globals: { palette: '${RULE}', style: '${STYLE_RULE}' }`;

// `dup` repeats a key, which loads (last wins) but earns the load's warning that
// the settings menu cannot edit the file; `clean` is the same config without it.
// `stuck` declares a variable whose cache key always throws, so it can never
// refresh (brandon-var-system-7wl9).
const CONFIGS = {
  clean: `{ ${GLOBALS}, segments: { mark: { template: 'mark' } }, root: { h: ['mark'] } }`,
  dup: `{ ${GLOBALS}, segments: { mark: { template: 'mark', template: 'mark' } }, root: { h: ['mark'] } }`,
  clock: `{ globals: { palette: '{{ if or (eq (mod (int (unixEpoch now)) 4) 0) (eq (mod (int (unixEpoch now)) 4) 1) }}no-such-theme{{ else }}dracula{{ end }}' }, segments: { mark: { template: 'mark' } }, root: { h: ['mark'] } }`,
  stuck: `{ ${GLOBALS}, variables: { stamp: { kind: "shell", command: "echo hi", cache: { key: '{{ fail "no key" }}' } } }, segments: { mark: { template: 'mark' } }, root: { h: ['mark'] } }`,
};

const fieldOf =
  (name: string) =>
  (line: string): string | undefined =>
    new RegExp(` ${name}=(\\S+)`).exec(line)?.[1];

describe("a daemon render's event names every warning, and the indicator offers each", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let daemon: InWorkerDaemon;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-warn-e2e");
    ({ env, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-render-warnings-e2e-"),
    );
    for (const [name, text] of Object.entries(CONFIGS))
      writeFileSync(path.join(projectDir, `${name}.json5`), text);
    daemon = startDaemon(prepared.env);
  });

  afterAll(async () => {
    await daemon?.stop();
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  const argsOf = (config: keyof typeof CONFIGS): string[] => [
    "cc-candybar",
    "--config",
    path.join(projectDir, `${config}.json5`),
  ];

  test.each([
    { config: "clean", sessionId: "clean-good", warn: "-", shown: [] },
    {
      config: "clean",
      sessionId: "clean-bad",
      warn: "rule:palette",
      shown: ["no-such-theme"],
    },
    {
      config: "clean",
      sessionId: "clean-threw",
      warn: "rule:style",
      shown: ["broke"],
    },
    {
      config: "dup",
      sessionId: "dup-good",
      warn: "load",
      shown: ["duplicate"],
    },
    {
      config: "dup",
      sessionId: "dup-bad",
      warn: "load,rule:palette",
      shown: ["duplicate", "no-such-theme"],
    },
    {
      config: "stuck",
      sessionId: "stuck-bad",
      warn: "rule:palette,refresh:stamp",
      shown: ["no-such-theme", "refresh"],
    },
  ] as const)(
    "$config config, session $sessionId: the viewer shows $shown and the event says warn=$warn",
    async ({ config, sessionId, warn, shown }) => {
      const args = argsOf(config);
      const draw = () => render(daemon, sessionId, projectDir, {}, args);
      // The first frame records what its walk met; the next one counts it.
      await draw();
      const bar = await draw();
      // The bar renders under every case: a warning never takes it away.
      expect(stripAnsi(bar)).toContain("mark");
      expect(indicatorOf(bar)).toBe(
        shown.length === 0 ? null : `⚠ ${shown.length}`,
      );
      // Each warning is its own message, in the event's order.
      const pages = await readDiagnostics(
        daemon,
        sessionId,
        projectDir,
        bar,
        {},
        args,
      );
      expect(pages).toHaveLength(shown.length);
      shown.forEach((word, i) => expect(pages[i]!.text).toContain(word));

      // A request the helper retried after a reply timeout is logged once per
      // attempt, and every attempt met the same warnings.
      const events = (await renderLines(env, sessionId, 2)).map(
        fieldOf("warn"),
      );
      for (const event of events) expect(event).toBe(warn);
    },
  );

  test("the record follows every frame: the count holds across frames, and opening the viewer moves nothing", async () => {
    // `-bad` makes the palette rule name no theme.
    const sid = "record-once-bad";
    const args = argsOf("clean");
    const draw = () => render(daemon, sid, projectDir, {}, args);
    // The first frame met the warning but drew before it was recorded.
    expect(indicatorOf(await draw())).toBeNull();
    const bars = [await draw(), await draw(), await draw()];
    for (const bar of bars) expect(indicatorOf(bar)).toBe("⚠ 1");
    const records = (await renderLines(env, sid, 4)).map(fieldOf("warnRecord"));
    expect(records).toEqual(["new", "kept", "kept", "kept"]);
    // Opening the viewer writes the session's state and draws the viewer in
    // the body's place, then the bar again with its indicator: none of those
    // frames moves the record, so the count cannot flip between them.
    const pages = await readDiagnostics(
      daemon,
      sid,
      projectDir,
      bars[0]!,
      {},
      args,
    );
    expect(pages.map((p) => p.position)).toEqual(["1/1"]);
    expect(indicatorOf(await draw())).toBe("⚠ 1");
    const all = await renderLines(env, sid, 6);
    expect(all.slice(4).map(fieldOf("warnRecord"))).toEqual(["kept", "kept"]);
    expect(all.map(fieldOf("diag"))).toEqual(["0", "1", "1", "1", "1", "1"]);
  });

  // Two facts about one loop: the load cannot tell whether the candidate
  // applies, and the watch cannot hear an edit made through it. Each shows
  // until the chain can be walked, and the edit that breaks the loop is heard.
  test("a config candidate whose link chain loops shows in the indicator until the loop is broken", async () => {
    const dir = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "cc-candybar-loop-e2e-")),
    );
    try {
      const sid = "config-loop";
      const link = path.join(dir, ".cc-candybar.json5");
      symlinkSync(`${link}.other`, link);
      symlinkSync(link, `${link}.other`);
      const draw = () => render(daemon, sid, dir);
      const bar = await draw();
      expect(indicatorOf(bar)).toBe("⚠ 2");
      const pages = await readDiagnostics(daemon, sid, dir, bar, {}, []);
      expect(pages.map((p) => p.text)).toEqual([
        expect.stringContaining(`config watch: cannot follow a link chain — ${link}`),
        expect.stringContaining(`could not be checked: ${link}`),
      ]);
      const events = (await renderLines(env, sid, 1)).map(fieldOf("warn"));
      expect(events[0]).toBe("config-watch,load");

      // A real file where the loop was: the watch hears it and reloads, and
      // the bar is left asking only whether to run the repository's config.
      // [LAW:no-ambient-temporal-coupling] The write is re-applied until the
      // watch has heard it.
      rmSync(`${link}.other`, { force: true });
      let healed = "";
      await untilHeard(
        () => {
          rmSync(link, { force: true });
          writeFileSync(link, `{ segments: {} }`);
        },
        async () => indicatorOf((healed = await render(daemon, sid, dir))) === "⚠ 1",
        "the bar once the loop is broken",
      );
      const left = await readDiagnostics(daemon, sid, dir, healed, {}, []);
      expect(left.map((p) => p.text)).toEqual([
        expect.stringContaining("run it?"),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // No edit in a folder the OS refuses reloads, so the fact stands on every bar
  // drawn from an entry that watches it, a bar drawn over a failed load too.
  test("a config folder the OS refuses shows in the indicator on every bar drawn from its entry", async () => {
    const dir = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "cc-candybar-refused-e2e-")),
    );
    const broken = path.join(dir, "broken.json5");
    writeFileSync(broken, "{ nope");
    const refusal = `config watch: cannot watch ${dir} — EMFILE`;
    // Every attempt the helper retried met the same warning.
    const everyEventNamesTheWatch = async (sid: string, answers: number) => {
      for (const line of await renderLines(env, sid, answers))
        expect(fieldOf("warn")(line)).toBe("config-watch");
    };
    fakeWatches(new Set([dir]));
    try {
      const sid = "refused";
      const bar = await render(daemon, sid, dir);
      expect(indicatorOf(bar)).toBe("⚠ 1");
      expect(indicatorOf(await render(daemon, sid, dir))).toBe("⚠ 1");
      await everyEventNamesTheWatch(sid, 2);
      const pages = await readDiagnostics(daemon, sid, dir, bar);
      expect(pages.map((p) => p.text)).toEqual([
        expect.stringContaining(refusal),
      ]);

      const another = "refused-too";
      expect(indicatorOf(await render(daemon, another, dir))).toBe("⚠ 1");
      await everyEventNamesTheWatch(another, 1);

      const failedSid = "refused-broken";
      const args = ["cc-candybar", "--config", broken];
      const failed = await render(daemon, failedSid, dir, {}, args);
      expect(indicatorOf(failed)).toBe("⚠ 2");
      await everyEventNamesTheWatch(failedSid, 1);
      const both = await readDiagnostics(daemon, failedSid, dir, failed, {}, args);
      expect(both.map((p) => p.text)).toEqual([
        expect.stringContaining(`Invalid config in ${broken}`),
        expect.stringContaining(refusal),
      ]);
    } finally {
      jest.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a warning a rule over the clock starts and stops", () => {
  test("is counted by the next frame, and cleared once it stops, while nothing about the frame moves", async () => {
    const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-warn-clock",
    );
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-render-warnings-e2e-"),
    );
    const config = path.join(projectDir, "clock.json5");
    writeFileSync(config, CONFIGS.clock);
    // The palette rule names no theme for two seconds of every four: the
    // config, the session's state and the width stay the same throughout.
    const clock = heldClock();
    const daemon = startDaemon(env, { clock });
    try {
      const sid = "record-clock";
      const args = ["cc-candybar", "--config", config];
      const draw = () => render(daemon, sid, projectDir, {}, args);
      const phase = (): number => (clock.date().getTime() / 1000) % 4;
      const enter = (from: number): void =>
        clock.advance(((from - phase() + 4) % 4) * 1000 + 150);
      await draw();
      enter(2);
      await draw();
      enter(0);
      await draw();
      expect(indicatorOf(await draw())).toBe("⚠ 1");
      enter(2);
      await draw();
      expect(indicatorOf(await draw())).toBeNull();
      const records = (await renderLines(env, sid, 5)).map(
        fieldOf("warnRecord"),
      );
      // The last four: met, counted, stopped, cleared.
      expect(records.slice(-4)).toEqual(["new", "kept", "new", "kept"]);
    } finally {
      await daemon.stop();
      rmSync(projectDir, { recursive: true, force: true });
      removeTmpDirs();
    }
  });
});
