// [LAW:nothing-unseen] brandon-effects-2gka.d2i, measured on a daemon: the
// render event — its `render sid=…` log line — names the effect the bar wore,
// the effect's own clock, and whether each row's effect was made or reused —
// and (brandon-effects-2gka.bm1) each placement wearing its own, on its clock.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  hookData,
  render,
  renderRequest,
} from "./helpers/daemon-e2e";
import {
  heldClock,
  startDaemon,
  type HeldClock,
  type InWorkerDaemon,
} from "./helpers/in-worker-daemon";
import {
  prepareIsolatedDaemonEnv,
} from "./helpers/spawn-isolated-daemon";
import { renderLines } from "./helpers/daemon-log";

jest.setTimeout(30_000);

describe("a daemon render's event names the effect it wore", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let config: string;
  let daemon: InWorkerDaemon;
  let clock: HeldClock;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-effect-e2e");
    ({ env, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-effect-e2e-"));
    config = path.join(projectDir, "shimmer.json5");
    writeFileSync(
      config,
      `{ globals: { effect: "shimmer" }, segments: { a: { template: 'steady' }, b: { template: 'own' } }, root: { h: ['a', { seg: 'b', settings: { effect: 'pulse' } }] } }`,
    );
    clock = heldClock();
    daemon = startDaemon(prepared.env, { clock });
  });

  afterAll(async () => {
    await daemon?.stop();
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("the first render brings the effect into force; the next reuses each row's effect on its clock", async () => {
    const sessionId = "effect-e2e-session";
    const argv = ["cc-candybar", "--config", config];
    await render(daemon, sessionId, projectDir, {}, argv);
    clock.advance(50);
    await render(daemon, sessionId, projectDir, {}, argv);

    const events = (await renderLines(env, sessionId, 2)).map((l) => ({
      effect: l.match(/ effect=(\S+) /)?.[1],
      t: Number(l.match(/ effectT=(\d+\.\d{3}) /)?.[1]),
      speed: l.match(/ speed=(\S+) /)?.[1],
      made: Number(l.match(/ effectRows=(\d+)made\//)?.[1]),
      reused: Number(l.match(/\/(\d+)reused /)?.[1]),
      own: l.match(/ effectOwn=(\S+) /)?.[1],
    }));
    const ownT = (own: string | undefined): number =>
      Number(own?.match(/^b:pulse@(\d+\.\d{3})$/)?.[1]);

    // A request the helper retried after a reply timeout is logged once per
    // attempt (the daemon finishes the attempt it was too slow to answer). A
    // render logs in the same synchronous step that draws it, so log order is
    // render order: the FIRST event brought the effect into force, and the LAST
    // is a later render of the same row.
    expect(events.length).toBeGreaterThanOrEqual(2);
    const first = events[0]!;
    const last = events[events.length - 1]!;
    expect(first).toMatchObject({
      effect: "shimmer",
      t: 0,
      speed: "1x",
      reused: 0,
    });
    expect(first.made).toBeGreaterThan(0);
    expect(last.effect).toBe("shimmer");
    expect(last.t).toBe(0.05);
    expect(last).toMatchObject({ made: 0, reused: first.made });
    // The placement's pulse came into force with the first render too, and
    // keeps its own clock.
    expect(ownT(first.own)).toBe(0);
    expect(ownT(last.own)).toBe(0.05);
  });

  // brandon-menus-sjhy.nt2: the event names the speed the session's animation
  // clock ran at, and the effect's clock runs at it.
  test("a session at 20x names its speed, and its effect's clock runs twenty times the wall's", async () => {
    const sessionId = "effect-e2e-speed";
    const fast = path.join(projectDir, "fast.json5");
    writeFileSync(
      fast,
      `{ globals: { effect: "shimmer", animationSpeed: "20x" }, segments: { a: { template: 'steady' } }, root: { h: ['a'] } }`,
    );
    const argv = ["cc-candybar", "--config", fast];
    await render(daemon, sessionId, projectDir, {}, argv);
    const gapMs = 100;
    clock.advance(gapMs);
    await render(daemon, sessionId, projectDir, {}, argv);

    const events = (await renderLines(env, sessionId, 2)).map((l) => ({
      speed: l.match(/ speed=(\S+) /)?.[1],
      t: Number(l.match(/ effectT=(\d+\.\d{3}) /)?.[1]),
    }));
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.every((e) => e.speed === "20x")).toBe(true);
    // One gap passed between the first render and the last, so the effect's
    // clock moved twenty.
    expect(events[events.length - 1]!.t).toBe((20 * gapMs) / 1000);
  });

  // brandon-effects-2gka.3vt: a placement the payload hides dissolves out, and
  // the event names it on its dissolve's clock.
  test("a placement that leaves is named on the event, its dissolve on its own clock", async () => {
    const sessionId = "effect-e2e-leaves";
    const leaving = path.join(projectDir, "leaving.json5");
    writeFileSync(
      leaving,
      `{ globals: { transitions: true }, variables: { modelName: { kind: "input", path: "model.display_name", type: "string" } }, segments: { a: { template: 'steady' }, b: { template: 'leaves', when: '{{ ne .modelName "gone" }}' } }, root: { h: ['a', 'b'] } }`,
    );
    const renderAs = (displayName: string): Promise<string> =>
      renderRequest(daemon, {
        hookData: {
          ...hookData(sessionId, projectDir),
          model: { id: "claude-opus-4-7", display_name: displayName },
        },
        args: ["cc-candybar", "--config", leaving],
        cwd: projectDir,
      });
    await renderAs("here");
    await renderAs("here");
    await renderAs("gone");

    const leaves = (await renderLines(env, sessionId, 3)).map(
      (l) => l.match(/ leaves=(\S+) /)?.[1],
    );
    // A retried request logs once per attempt, so the event that saw `b`
    // leave is the first naming it, and every event before it names none.
    const left = leaves.findIndex((l) => l !== "-");
    expect(left).toBeGreaterThan(0);
    expect(leaves.slice(0, left).every((l) => l === "-")).toBe(true);
    expect(leaves[left]).toBe("b@0.000");
  });
});
