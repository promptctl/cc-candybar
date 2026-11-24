import { reportingClock } from "../../../src/daemon/task-throws";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeAnsi } from "@promptctl/rich-js";

import {
  openFrameStream,
  type FrameStream,
  type StreamEnd,
} from "../../../src/daemon/client-frames";
import { plainEnvironment } from "../../../src/daemon/foundations/session-env";
import { exits, shell } from "../../../src/proc/spawner-fake";
import { textOf } from "../../../src/render/frame";
import { FEED_PERIODS } from "../../../src/renderer/feeds";
import { frameRequest, renderBody } from "../../helpers/daemon-e2e";
import { fakeLauncher, type FakeLauncher } from "../../../scripts/lib/draw-fixtures/fake-launcher";
import { heldClock } from "../../helpers/held-clock";
import {
  startDaemon,
  statsOf,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../../scripts/lib/daemon/isolated";
import { until } from "../../../scripts/lib/until";

const TTL_MS = 5_000;
const COMMAND = "printf sample";
const FIRST = "source-before-ttl";
const SECOND = "source-after-ttl";

// [LAW:behavior-not-structure] A moving pane can deliver many frames while
// missing a source update. Both phases must visibly carry the source's value.
test("a moving pane reads the same source until its host period refreshes it", async () => {
  const isolated = prepareIsolatedDaemonEnv("ccb-reads-only");
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "ccb-reads-only-"));
  const clock = heldClock(new Date(), reportingClock);
  let daemon: InWorkerDaemon | undefined;
  let stream: FrameStream | undefined;
  try {
    const config = path.join(projectDir, "bar.json5");
    writeFileSync(
      config,
      `{
      globals: { experimentalPane: true },
      variables: {
        sample: { kind: "shell", command: ${JSON.stringify(COMMAND)}, cache: { ttl: "${TTL_MS / 1000}s" } },
      },
      segments: {
        sample: { template: '{{ .sample }} {{ frames 0.05 "phase-a" 0.05 "phase-b" }}' },
        lanes: { template: '{{ .metrics.messageCount }} {{ .session.cost }}' },
      },
      root: { h: ['sample', 'lanes'] },
    }`,
    );

    let launcher: FakeLauncher | undefined;
    const matches = shell(COMMAND);
    daemon = startDaemon(isolated.env, {
      clock,
      launcher: (owner) => {
        launcher = fakeLauncher(clock, owner);
        launcher.spawner.program(matches, exits(0, `${FIRST}\n`));
        return launcher.launcher;
      },
    });
    if (launcher === undefined) throw new Error("the daemon built no launcher");
    const { started, spawner } = launcher;
    const reads = () =>
      started().filter(({ bin, args }) => matches(bin, args)).length;
    await daemon.listen(isolated.sockPath);

    const session = "reads-only";
    const request = renderBody(session, projectDir, {}, [
      "cc-candybar",
      "--config-only",
      config,
    ]);
    const firstRead = async () => {
      await until(() => reads() > 0, "the first shell read");
      await clock.settle(0);
    };
    const [first] = await Promise.all([
      frameRequest(daemon, { ...request, env: plainEnvironment({}) }),
      firstRead(),
    ]);
    expect(textOf(first)).toContain(FIRST);

    const received: string[] = [];
    let ended: StreamEnd | undefined;
    stream = openFrameStream(
      isolated.sockPath,
      session,
      "pane",
      (response) => {
        if (!response.ok || !("output" in response))
          throw new Error(
            `expected a drawn pane frame: ${JSON.stringify(response)}`,
          );
        received.push(decodeAnsi(response.output).plain);
      },
      (end) => {
        ended = end;
      },
    );
    const live = (condition: () => boolean) => {
      if (ended !== undefined)
        throw new Error(
          `pane subscription ended: ${ended.kind === "failed" ? ended.error.message : JSON.stringify(ended)}`,
        );
      return condition();
    };
    await until(async () => {
      await clock.settle(0);
      return live(() => received.length > 0);
    }, "the pane's first frame");

    const before = (await statsOf(daemon.daemon)).sources.records;
    spawner.program(matches, exits(0, `${SECOND}\n`));
    await clock.settle(TTL_MS - 1);
    const shows = (text: string) =>
      received.some((frame) => frame.includes(text));
    await until(
      () => live(() => shows("phase-a") && shows("phase-b")),
      "both visible animation phases before the TTL",
    );
    expect(reads()).toBe(1);
    for (const frame of received) expect(frame).toContain(FIRST);

    await clock.settle(1);
    expect(reads()).toBe(2);
    await clock.settle(FEED_PERIODS.still);
    await until(
      () => live(() => shows(SECOND)),
      () =>
        `the refreshed shell value in the pane (last frame: ${received.at(-1)})`,
    );

    const after = (await statsOf(daemon.daemon)).sources.records;
    for (const { name, scope, refreshes } of after) {
      const previous = before.find(
        (record) => record.name === name && record.scope === scope,
      );
      const { period: _period, ...other } = refreshes;
      const { period: _previousPeriod, ...prior } = previous?.refreshes ?? {};
      expect({ source: `${scope}/${name}`, other }).toEqual({
        source: `${scope}/${name}`,
        other: prior,
      });
    }
    expect(
      after.find(({ name }) => name === "source.shell")?.refreshes,
    ).toMatchObject({ first: 1, period: 1 });
  } finally {
    stream?.close();
    await daemon?.stop();
    rmSync(projectDir, { recursive: true, force: true });
    isolated.removeTmpDirs();
  }
});
