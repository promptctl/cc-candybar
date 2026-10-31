// DRAW_RESERVE_MS is measured (brandon-unfiled-3248.8ro6, §4c): a request's
// wait ends that long before its client hangs up, so the draw after it must
// fit inside it. This holds the constant to the slowest draw a request makes
// — a session's first draw of its view, every part evaluated cold — at p99,
// over the bundled default and the load gate's full config, as the render
// cache's byte constants are held to their measured heap.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DRAW_RESERVE_MS } from "../src/daemon/request-deadline";
import { killAndWait, renderBody, renderRequest } from "./helpers/daemon-e2e";
import { loggedLines } from "./helpers/daemon-log";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(120_000);

const SAMPLES = 100;
const LOAD_GATE = path.join(__dirname, "..", "scripts", "load-gate");

describe("the draw's reserve", () => {
  let daemon: RunningDaemon | undefined;
  let sockPath: string;
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let root: string;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-draw-reserve");
    ({ sockPath, removeTmpDirs } = prepared);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-draw-reserve-"));
    // The full config's plugin segment, where the daemon looks for plugins.
    const data = path.join(root, "data");
    fs.cpSync(
      path.join(LOAD_GATE, "plugins"),
      path.join(data, "cc-candybar", "plugins"),
      { recursive: true },
    );
    env = { ...prepared.env, XDG_DATA_HOME: data };
    daemon = await spawnDaemonWithEnv(env);
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    fs.rmSync(root, { recursive: true, force: true });
    removeTmpDirs();
  });

  test.each([
    ["the bundled default", "{}"],
    [
      "the load gate's full config",
      fs.readFileSync(path.join(LOAD_GATE, "config.json5"), "utf8"),
    ],
  ])("%s's cold first draws fit DRAW_RESERVE_MS at p99", async (name, text) => {
    const dir = fs.mkdtempSync(path.join(root, "checkout-"));
    const config = path.join(dir, "config.json5");
    fs.writeFileSync(config, text);
    const ask = (sid: string) =>
      renderRequest(
        sockPath,
        renderBody(sid, dir, { termCols: 160, termRows: 40 }, [
          "cc-candybar",
          "--config",
          config,
        ]),
      );
    // The entry compiled first: a compile is the arrival turn's, never the
    // draw's.
    const tag = path.basename(dir);
    await ask(`${tag}-warm`);
    for (let i = 0; i < SAMPLES; i++) await ask(`${tag}-${i}`);
    // A session's first draw alone: an ask the helper repeated, because the
    // first drew pending, draws warm.
    const drawn = new RegExp(`\\] render sid=(${tag}-\\d+) .* drew=(\\d+)ms `);
    const drew = (lines: readonly string[]): number[] => {
      const first = new Map<string, number>();
      for (const line of lines) {
        const m = line.match(drawn);
        if (m !== null && !first.has(m[1]!)) first.set(m[1]!, Number(m[2]));
      }
      return [...first.values()];
    };
    const samples = drew(
      await loggedLines(
        env,
        (lines) => lines.filter((l) => drawn.test(l)),
        (found) => drew(found).length >= SAMPLES,
        `${SAMPLES} render events for ${name}`,
      ),
    ).sort((a, b) => a - b);
    const p99 = samples[Math.ceil(0.99 * samples.length) - 1]!;
    expect(p99).toBeLessThanOrEqual(DRAW_RESERVE_MS);
  });
});
