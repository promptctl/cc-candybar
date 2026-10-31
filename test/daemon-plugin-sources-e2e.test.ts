// [LAW:nothing-unseen] A plugin's session source and its `run` action,
// measured on a daemon: the bar a request draws before and after the
// plugin's program writes the session's file, the bar while a clicked program
// runs and after it exits, a forged link's refusal in the bar, the daemon's
// request and run counts, the config-load event's `sources=`, and the render
// event's `sources=`/`sourcesPending=` — the daemon's own wiring of the storage
// owner into the render states and the views' declarations, and of the run
// owner into the click.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hookData, linkUrls, renderRequest, sendClick, stripAnsi } from "./helpers/daemon-e2e";
import { until } from "./helpers/until";
import { untilHeard } from "./helpers/reload-signal";
import { startDaemon, type InWorkerDaemon } from "./helpers/in-worker-daemon";
import {
  prepareIsolatedDaemonEnv,
} from "./helpers/spawn-isolated-daemon";
import { loggedWhen, renderLines } from "./helpers/daemon-log";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import { effectsOf } from "./helpers/click";
import { effectsUrl, VERB_RUN } from "../src/click/wire";
import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import type { StatsSnapshot } from "../src/daemon/stats";
import { LOADING_GLYPH } from "../src/dsl/node-registry";

import { viewerLink } from "./helpers/diagnostics-viewer";

jest.setTimeout(30_000);

const SESSION = "sources-e2e-0001";
// Longer than a request's whole budget, so a request waiting on the run would
// time out.
const PROGRAM_SLEEPS_S = 2;

// The fixture program, in the plugin's folder: after `DELAY` seconds it writes
// the session's file whole, by rename, and exits.
const PROGRAM = `#!/bin/sh
sleep "$DELAY"
mkdir -p session
printf '{"home":"%s"}' "$HOME_VALUE" > "session/.$1.tmp"
mv "session/.$1.tmp" "session/$1.json"
`;

describe("a daemon reads a plugin's session source and runs its program", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let dataHome: string;
  let config: string;
  let storage: string;
  let daemon: InWorkerDaemon;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-sources-e2e");
    ({ env, removeTmpDirs } = prepared);
    projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-sources-e2e-")));
    // The plugin is INSTALLED: a folder in the user's plugin root, listed by
    // no config.
    dataHome = path.join(projectDir, "data");
    const folder = path.join(dataHome, "cc-candybar", "plugins", "p");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "write.sh"), PROGRAM, { mode: 0o755 });
    fs.writeFileSync(
      path.join(folder, "plugin.json5"),
      `{
        sources: { status: { scope: "session", refresh: { watch: true }, read: { file: { json: true } } } },
        segments: {
          gated: { when: '{{ hasKey .plugins.p "status" }}', template: 'home={{ .plugins.p.status.home }}' },
          go: { template: '{{ action "plugins.p.go" "[go]" }}' },
        },
        actions: {
          go: {
            run: ["./write.sh", "{{ .session.id }}"],
            env: { HOME_VALUE: "/h/ran", DELAY: "${PROGRAM_SLEEPS_S}" },
            refreshes: ["status"],
          },
        },
      }`,
    );
    config = path.join(projectDir, "config.json5");
    fs.writeFileSync(
      config,
      `{ segments: { mine: { template: "mine" } }, root: { h: ["mine", "plugins.p.gated", "plugins.p.go"] } }`,
    );
    storage = path.join(fs.realpathSync(folder), "session");
    daemon = startDaemon({ ...prepared.env, XDG_DATA_HOME: dataHome });
  });

  afterAll(async () => {
    await daemon?.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  // The request the client sends for this session.
  const body = (): Record<string, unknown> => ({
    hookData: hookData(SESSION, projectDir),
    args: ["cc-candybar", "--config", config],
    cwd: projectDir,
  });

  // A render as the client asks for one, retried on TIMEOUT: the bytes it drew.
  const renderRaw = (): Promise<string> => renderRequest(daemon, body());
  const render = async (): Promise<string> => stripAnsi(await renderRaw());

  // ONE render, not retried: a request that timed out fails here.
  const renderOnce = async (): Promise<string> => {
    const resp = await sendDaemonRequest(daemon, { v: PROTOCOL_VERSION, kind: "render", ...body() });
    if (!resp.ok || !("output" in resp)) throw new Error(`render failed: ${JSON.stringify(resp)}`);
    return stripAnsi(resp.output);
  };

  const stats = async (): Promise<StatsSnapshot> => {
    const resp = await sendDaemonRequest(daemon, { v: PROTOCOL_VERSION, kind: "stats" });
    if (!resp.ok || !("stats" in resp)) throw new Error(`stats failed: ${JSON.stringify(resp)}`);
    return resp.stats as StatsSnapshot;
  };

  // Renders until the bar (escapes stripped) shows what is waited for; the
  // bytes of that render.
  const renderUntil = async (shows: (bar: string) => boolean, what: string): Promise<string> => {
    let raw = "";
    await until(
      async () => shows(stripAnsi((raw = await renderRaw()))),
      () => `the bar showing ${what}; last:\n${stripAnsi(raw)}`,
      10_000,
    );
    return raw;
  };

  // The run link the bar drew, read out of its bytes.
  const runLink = (rendered: string): string => {
    const url = linkUrls(rendered).find((u) => effectsOf(u).some((e) => e.verb === VERB_RUN));
    if (url === undefined) throw new Error(`no run link in ${JSON.stringify(rendered)}`);
    return url;
  };

  test("hidden until the program writes, then the write draws; the events count the source", async () => {
    const first = await render();
    expect(first).toContain("mine");
    expect(first).not.toContain("home=");
    // The load created the folder the program writes into.
    expect(fs.statSync(storage).isDirectory()).toBe(true);
    await loggedWhen(
      env,
      (lines) => lines.some((l) => l.includes("config load ") && l.includes(" sources=1 pluginVariables=0 ")),
      "the config-load event counting the plugin's source",
    );
    // The request waited for the source's first read, so nothing was pending
    // when it drew. The answer `render` took is the last event: under load an
    // ask can end at its deadline first, and `render` asks again.
    const event = (await renderLines(env, SESSION)).at(-1);
    expect(event).toContain(" sources=1 sourcesPending=- ");

    // The program's write: the whole file, renamed into place, again until a
    // render shows it (the folder's watch goes live after it opens).
    let bar = "";
    await untilHeard(
      () => {
        const tmp = path.join(storage, `.${SESSION}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify({ home: "/h/before" }));
        fs.renameSync(tmp, path.join(storage, `${SESSION}.json`));
      },
      async () => {
        bar = await render();
        return bar.includes("home=/h/before");
      },
      () => `the bar showing the program's write; last:\n${bar}`,
    );
  });

  test("a click runs the drawn program; while it runs the source draws its loading cell and no request times out; then its write", async () => {
    const link = runLink(await renderUntil((b) => b.includes("home=/h/before"), "the value before the click"));
    const before = await stats();

    const clicked = await sendClick(daemon, link);
    expect(clicked).toMatchObject({ ok: true });

    // The program sleeps past a request's budget before it writes. A request
    // now neither waits for it nor draws the value from before the click.
    const during = await renderOnce();
    expect(during).toContain(LOADING_GLYPH);
    expect(during).not.toContain("home=/h/before");
    expect(during).not.toContain("home=/h/ran");
    const whileRunning = await stats();
    expect(whileRunning.requests.timedOut).toBe(before.requests.timedOut);
    expect(whileRunning.runs).toMatchObject({ started: before.runs.started + 1, running: 1 });

    await renderUntil((b) => b.includes("home=/h/ran"), "the program's write");
    const after = await stats();
    expect(after.runs).toMatchObject({ started: before.runs.started + 1, running: 0, failed: 0, timedOut: 0 });
    expect(after.requests.timedOut).toBe(before.requests.timedOut);
    await loggedWhen(
      env,
      (lines) => lines.some((l) => l.includes(`run sid=${SESSION} action=plugins.p.go program=./write.sh outcome=ok exit=0 `)),
      "the run's event",
    );
  });

  test("a forged link is refused, runs nothing, and its refusal is drawn", async () => {
    const link = runLink(await renderRaw());
    const run = effectsOf(link).find((e) => e.verb === VERB_RUN)!;
    const [sid, action, evaluated] = run.args as [string, string, string, string];
    const forged = effectsUrl([
      { verb: VERB_RUN, args: [sid, action, evaluated.replace("/h/ran", "/h/forged"), run.args[3]!] },
    ]);
    const before = await stats();

    const refused = await sendClick(daemon, forged);
    expect(refused).toMatchObject({ ok: false });
    expect((await stats()).runs).toMatchObject({ started: before.runs.started, refused: before.runs.refused + 1 });
    // The refusal is the bar's one message: the indicator counts it, and the
    // viewer it opens shows it.
    const bar = await renderUntil((b) => b.includes("⚠ 1"), "the forged link's refusal");
    const open = viewerLink(bar, "open")!;
    expect((await sendClick(daemon, open.url)).ok).toBe(true);
    const shown = stripAnsi(await renderRaw());
    expect(shown).toContain("signature does not match");
    expect(shown).not.toContain("/h/forged");
    expect((await sendClick(daemon, viewerLink(await renderRaw(), "✕")!.url)).ok).toBe(true);
    expect(await render()).not.toContain("/h/forged");
  });
});
