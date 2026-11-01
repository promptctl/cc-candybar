// brandon-unfiled-3248.8ro6, measured on a daemon: every input refreshes
// on its own clock, and drawing a frame only reads. A feed draws a moving bar
// many times a second between a session's statusline requests; across those
// frames no source refreshes but the ones whose own period fell due, so a
// `shell` variable with a 5 s `ttl` runs once per 5 s however fast the bar is
// drawn, never once per frame.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openFrameStream, type FrameStream } from "../src/daemon/client-frames";
import type { SourceRecord } from "../src/utils/refresh-ledger";
import { render } from "./helpers/daemon-e2e";
import { until } from "./helpers/until";
import { startDaemon, statsOf, type InWorkerDaemon } from "./helpers/in-worker-daemon";
import {
  prepareIsolatedDaemonEnv,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

const TTL_S = 5;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Each source's refreshes summed over its triggers.
const refreshesOf = (r: SourceRecord): number =>
  Object.values(r.refreshes).reduce((sum, n) => sum + (n ?? 0), 0);

describe("drawing a frame only reads", () => {
  let sockPath: string;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let runs: string;
  let daemon: InWorkerDaemon;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-reads-only-e2e");
    ({ sockPath, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-reads-only-"));
    runs = path.join(projectDir, "runs");
    writeFileSync(runs, "");
    // A bar that moves (sparkle), reads a shell source on a 5 s period, and
    // reads the session lanes a request refreshes.
    writeFileSync(
      path.join(projectDir, "bar.json5"),
      `{
        globals: { effect: "sparkle", experimentalStatusline: true },
        variables: {
          counted: {
            kind: "shell",
            command: ${JSON.stringify(`echo run >> ${runs}; echo counted`)},
            cache: { ttl: "${TTL_S}s" },
          },
        },
        segments: {
          shell: { template: '{{ .counted }}' },
          lanes: { template: 'a moving mark {{ .metrics.messageCount }} {{ .session.cost }}' },
        },
        root: { h: ['shell', 'lanes'] },
      }`,
    );
    daemon = startDaemon(prepared.env);
    await daemon.listen(sockPath);
  });

  afterAll(async () => {
    await daemon?.stop();
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("a feed's frames between requests refresh no source; a 5 s ttl shell runs once per 5 s", async () => {
    const args = ["cc-candybar", "--config", path.join(projectDir, "bar.json5")];
    const sessionId = "reads-only";
    await render(sockPath, sessionId, projectDir, {}, args);
    const ranAt = (): number =>
      readFileSync(runs, "utf8").split("\n").filter(Boolean).length;
    await until(() => ranAt() >= 1, "the shell's first run");

    let frames = 0;
    let stream: FrameStream | null = null;
    const open = (): FrameStream =>
      openFrameStream(
        sockPath,
        sessionId,
        "statusline",
        () => frames++,
        (end) => {
          // A daemon too busy to take the subscribe inside its budget answers
          // TIMEOUT; a subscriber opens another.
          if (end.kind === "refused" && end.resp.code === "TIMEOUT")
            stream = open();
        },
      );
    stream = open();
    try {
      await until(() => frames > 0, "the feed's first frame");
      const before = await statsOf(daemon.daemon);
      // One period of the shell, and a second beyond it: the bar is drawn many
      // times a second throughout, and no request arrives.
      await sleep((TTL_S + 1) * 1000);
      const after = await statsOf(daemon.daemon);

      const drawn = after.frameFeeds.drawn - before.frameFeeds.drawn;
      // 30 a second while the bar moves; a fifth of that leaves room for a
      // slow CI box, and is far past one frame per period.
      expect(drawn).toBeGreaterThanOrEqual(6 * (TTL_S + 1));

      // The shell ran its first read and at most one period's since: once per
      // 5 s, however many frames read it.
      expect(ranAt()).toBeGreaterThanOrEqual(1);
      expect(ranAt()).toBeLessThanOrEqual(2);

      // [LAW:verifiable-goals] Every refresh the window saw was a period
      // falling due: no request, first read, change or supersede ran, so no
      // frame refreshed anything.
      const moved = after.sources.records.flatMap((r) => {
        const prior = before.sources.records.find(
          (b) => b.name === r.name && b.scope === r.scope,
        );
        const by = Object.entries(r.refreshes).flatMap(([trigger, n]) => {
          const was = prior?.refreshes[trigger as keyof typeof r.refreshes] ?? 0;
          return (n ?? 0) > was ? [`${r.scope}/${r.name}:${trigger}`] : [];
        });
        return by;
      });
      for (const m of moved) expect(m).toMatch(/:period$/u);
      const shell = after.sources.records.find((r) => r.name === "var.counted");
      expect(shell).toMatchObject({ scope: "directory" });
      expect(refreshesOf(shell!)).toBe(ranAt());
    } finally {
      (stream as FrameStream | null)?.close();
    }
  });
});
