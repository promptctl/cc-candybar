// A request is answered by its client's deadline, whatever its sources are
// still doing (brandon-unfiled-3248.8ro6, §4c): a source still reading then
// draws as pending, and lands for the session's next render. The tmux stub
// answers only once the test opens the gate, so the source provably outlives
// the deadline — an ordering the test owns, not a bet on how slow a render is.
// A real process, because that answer's cold first draw has to fit the draw's
// reserve in wall time, the bound test/draw-reserve.process.test.ts holds, and because
// what the backstop answers below is decided by the loop's own turns.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { stripAnsi } from "./helpers/ansi";
import { PROTOCOL_VERSION, TOTAL_BUDGET_MS } from "../src/daemon/protocol";
import { REQUEST_TIMEOUT_MS } from "../src/daemon/request-deadline";
import { killAndWait, renderBody, renderRequest } from "./helpers/daemon-e2e";
import { loggedWhen } from "./helpers/daemon-log";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import { field, landedEvents, only } from "./helpers/request-event";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { HELD_CONFIG, tmuxStub, type TmuxStub } from "./helpers/tmux-stub";

const TEST_TIMEOUT_MS = 30_000;

jest.setTimeout(TEST_TIMEOUT_MS);

describe("a request's time limits", () => {
  let env: NodeJS.ProcessEnv;
  let sockPath: string;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let tmuxDir: string;
  let args: string[];
  let stub: TmuxStub | undefined;
  let daemon: RunningDaemon | undefined;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-event-deadline");
    ({ sockPath, env, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-render-event-e2e-"),
    );
    const config = path.join(projectDir, "held.json5");
    writeFileSync(config, HELD_CONFIG);
    args = ["cc-candybar", "--config", config];
    tmuxDir = path.join(projectDir, "bin");
    mkdirSync(tmuxDir);
    stub = await tmuxStub(tmuxDir);
    daemon = await spawnDaemonWithEnv({
      ...prepared.env,
      PATH: `${tmuxDir}${path.delimiter}${prepared.env.PATH ?? ""}`,
    });
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    await stub?.close();
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("a source that outlives its client's deadline draws pending, and lands for the next render", async () => {
    const tmuxBody = (sid: string, pane: string) =>
      renderBody(
        sid,
        projectDir,
        {
          // A socket inside the test's own directory: were the stub ever
          // bypassed, a real tmux would find no server there.
          tmux: {
            socket: path.join(tmuxDir, "tmux.sock"),
            pane,
            truecolor: null,
          },
        },
        args,
      );
    const stats = () =>
      sendDaemonRequest(sockPath, { v: PROTOCOL_VERSION, kind: "stats" });

    // The config's entry compiled first, by a render that reports no pane,
    // so the deadline below is spent on the wait, not on a compile.
    await renderRequest(sockPath, {
      ...tmuxBody("ev-late-warm", "%0"),
      tmux: null,
    });
    // A client that states its deadline, as the native one does: its budget
    // counted from before it connects.
    const deadline = Date.now() + TOTAL_BUDGET_MS;
    const stated = await sendDaemonRequest(sockPath, {
      v: PROTOCOL_VERSION,
      kind: "render",
      ...tmuxBody("ev-late", "%1"),
      deadline,
    });
    expect(Date.now()).toBeLessThanOrEqual(deadline);
    expect(stated).toMatchObject({ ok: true });
    expect(stripAnsi((stated as { output: string }).output)).toContain("…");
    await stub!.asked(1);
    const late = only(await landedEvents(env, "ev-late", 1));
    expect(field(late, "outcome")).toBe("ok");
    expect(field(late, "timedOut")).toBe("N");
    expect(field(late, "deadline")).toMatch(/^stated:\d+ms$/u);
    expect(field(late, "ended")).toBe("deadline");
    expect(field(late, "pending")).toBe("tmux.session");
    // Answered, it holds nothing, though its source reads on: `using`
    // released the hold on exit.
    await expect(stats()).resolves.toMatchObject({
      ok: true,
      stats: { renderCache: { held: 0, retired: 0 } },
    });

    // The read lands, and the session's next render draws it, waiting on
    // nothing.
    await stub!.open(1);
    await loggedWhen(
      env,
      (lines) => lines.some((l) => / tmux refresh .* outcome=ok /u.test(l)),
      "tmux's read landing",
    );
    const drawn = stripAnsi(
      await renderRequest(sockPath, tmuxBody("ev-late", "%1")),
    );
    expect(drawn).toContain("held");
    expect(field((await landedEvents(env, "ev-late", 2))[1]!, "ended")).toBe("answered");

    // A client too old to state its deadline is answered by the earliest an
    // old client gives up at — the native client's, whose budget runs from
    // before its connect — so within its whole budget, the connect included.
    const sent = Date.now();
    await expect(
      sendDaemonRequest(sockPath, {
        v: PROTOCOL_VERSION,
        kind: "render",
        ...tmuxBody("ev-late-unstated", "%2"),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(Date.now() - sent).toBeLessThanOrEqual(TOTAL_BUDGET_MS);
    const unstated = only(await landedEvents(env, "ev-late-unstated", 1));
    expect(field(unstated, "deadline")).toMatch(/^unstated:\d+ms$/u);
    expect(field(unstated, "ended")).toBe("deadline");
    // Its stub is still reading: let it answer rather than be killed.
    await stub!.asked(2);
    await stub!.open(2);
  });

  // The connection's backstop answers TIMEOUT whatever the render is still
  // doing. A wait ends before it, so what outlives it is a synchronous turn:
  // here the first request's compile of a config big enough to take several
  // times the backstop. The render's event says the client read another
  // reply, and the hold it drew under is released when it ends. Last, since
  // so big a compile slows whatever the daemon does next.
  test("a render that outlives its request timeout writes timedOut=Y", async () => {
    const segments = Object.fromEntries(
      Array.from({ length: 600 }, (_, i) => [
        `s${i}`,
        { template: `{{ .session.id }} ${i}` },
      ]),
    );
    const config = path.join(projectDir, "heavy.json5");
    writeFileSync(
      config,
      JSON.stringify({ segments, root: { h: Object.keys(segments) } }),
    );
    // [LAW:no-ambient-temporal-coupling] The backstop's TIMEOUT reply is a
    // task on the daemon's loop, so it cannot be written until the
    // synchronous compile yields: this client's wait is bounded by the
    // compile, seconds on CI's two cores, not by the backstop. The helper's
    // default budget is for an answered request, so the budget here is the
    // test's own timeout, and nothing ends the wait before Jest would. The
    // event's `took` below is what says the render outlived the backstop.
    await expect(
      sendDaemonRequest(
        sockPath,
        {
          v: PROTOCOL_VERSION,
          kind: "render",
          ...renderBody("ev-backstop", projectDir, {}, [
            "cc-candybar",
            "--config",
            config,
          ]),
          deadline: Date.now() + TOTAL_BUDGET_MS,
        },
        TEST_TIMEOUT_MS,
      ),
    ).resolves.toMatchObject({ ok: false, code: "TIMEOUT" });
    const late = only(await landedEvents(env, "ev-backstop", 1));
    expect(field(late, "outcome")).toBe("ok");
    expect(field(late, "timedOut")).toBe("Y");
    expect(Number(field(late, "took")?.replace(/ms$/u, ""))).toBeGreaterThan(
      REQUEST_TIMEOUT_MS,
    );
    await expect(
      sendDaemonRequest(sockPath, { v: PROTOCOL_VERSION, kind: "stats" }),
    ).resolves.toMatchObject({ ok: true, stats: { renderCache: { held: 0 } } });
  });
});
