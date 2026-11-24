// [LAW:nothing-unseen] The stats reply's panel of one renderer: one that is
// not running is not asked, so a stats poll is no input it refused, and one
// that does not answer fails its own panel inside the reply's budget instead
// of holding the reply past the connection's backstop.

import { rendererNameOf } from "../../src/daemon/foundations/renderer-name";
import type { ProcessMemory } from "../../src/daemon/foundations/memory-limit";
import type { RendererProcessState } from "../../src/daemon/renderer-process";
import { RENDERER_STATS_REFERENCE } from "../../src/daemon/foundations/stats-snapshot";
import { RENDERER_STATS_WAIT_MS, rendererPanel } from "../../src/daemon/reply";
import { heldClock } from "../helpers/held-clock";

const name = rendererNameOf("worktree");
const mailbox = { holder: "render", heldMs: 900, queued: 3 } as const;
const memory: ProcessMemory = {
  pid: 4343,
  memory: { kind: "unmeasured" },
  limit: 512 * 1024 * 1024,
};
const limits = { renderer: () => memory };
// A renderer spawned and not yet read.
const spawned: RendererProcessState = {
  kind: "spawned",
  process: {
    name,
    generation: 1,
    pid: 4343,
    usage: { kind: "unread", why: "no ping has answered yet" },
    heapSnapshot: () => Promise.reject(new Error("not live")),
    end: () => {},
  },
};

describe("a renderer's stats panel", () => {
  test("one not running is not asked, and its panel says why", async () => {
    let asked = 0;
    const panel = await rendererPanel(
      {
        name,
        ask: () => {
          asked++;
          return new Promise(() => {});
        },
        process: { kind: "not-running", why: "it exited 1" },
        mailbox,
      },
      limits,
      heldClock(new Date(0)),
    );
    expect(asked).toBe(0);
    expect(panel).toEqual({
      name,
      process: { kind: "not-running", why: "it exited 1" },
      mailbox,
      stats: {
        kind: "failed",
        reason: "not asked: it is not running: it exited 1",
      },
    });
  });

  test("one that does not answer fails its panel once the wait is spent", async () => {
    const clock = heldClock(new Date(0));
    const panel = rendererPanel(
      {
        name,
        ask: () => new Promise(() => {}),
        process: spawned,
        mailbox,
      },
      limits,
      clock,
    );
    clock.advance(RENDERER_STATS_WAIT_MS);
    await expect(panel).resolves.toEqual({
      name,
      process: { kind: "process", memory },
      mailbox,
      stats: {
        kind: "failed",
        reason: `no answer within ${RENDERER_STATS_WAIT_MS} ms`,
      },
    });
  });

  test("one that answers leaves no wait armed", async () => {
    const clock = heldClock(new Date(0));
    const stats = RENDERER_STATS_REFERENCE;
    const panel = await rendererPanel(
      {
        name,
        ask: async () => stats,
        process: spawned,
        mailbox,
      },
      limits,
      clock,
    );
    expect(panel.stats).toEqual({ kind: "ok", value: stats });
    expect(clock.pending()).toBe(0);
  });
});
