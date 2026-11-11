// The main renderer answers a statusline request through `answer` alone
// (src/renderer/interface.ts): the request's turn returns one `present` for
// the statusline, carrying the request it answers and the frame drawn, and the
// present's `effect-done` is what records what the frame showed.
//
// [LAW:behavior-not-structure] The renderer is built over the daemon's own
// view composition (test/helpers/session-rig.ts) and narrow fakes for the host
// parts its side still reaches; no daemon is built.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UNFOLLOWED_FEEDS } from "../src/config/lanes";
import type { RendererParts } from "../src/daemon/draw-bar";
import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import { checkRenderRequest } from "../src/daemon/render-checkpoint";
import { RenderWarningRecords } from "../src/daemon/render-warnings";
import { EffectSessions } from "../src/render/effect";
import {
  TurnThrew,
  type Effect,
  type EffectId,
  type Renderer,
  type RequestId,
} from "../src/renderer/interface";
import { mainRenderer } from "../src/renderer/main";
import type { CheckedRenderRequest } from "../src/renderer/request-context";
import { systemTimekeeper } from "../src/time";
import { TEST_SIGNER } from "./helpers/link-signer";
import { AT, PROJECT, SESSION, requestOf, sessionRig } from "./helpers/session-rig";

let dir: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-answer-")));
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

const NO_STATS = { size: 0, hits: 0, misses: 0 };

// The renderer over the rig's render cache and owners, and the copies each
// delivered frame recorded in that cache, in the order they were recorded.
function renderer(): {
  readonly r: Renderer;
  readonly recorded: string[][];
} {
  const rig = sessionRig(dir, cleanups);
  const { providers } = rig;
  const parts: RendererParts = {
    clock: systemTimekeeper,
    log: () => {},
    sessionState: rig.sessionState,
    renderCache: rig.cache as never,
    payloadProviders: {
      ...providers,
      gitProvider: { ...providers.gitProvider, getStats: () => NO_STATS },
      usageStore: { ...providers.usageStore, getStats: () => NO_STATS },
    } as never,
    linkSigner: TEST_SIGNER,
    renderWarnings: new RenderWarningRecords(),
    effectSessions: new EffectSessions(),
    frameFeeds: { feedsOf: () => UNFOLLOWED_FEEDS, following: () => new Set() },
    updateWatch: { notice: () => ({ offer: [], failure: [] }), error: () => null },
    fileEvents: {
      delivery: () => ({ kind: "delivering", unreported: [], missedSince: null }),
    },
    menuIdle: { observe: () => {}, since: () => undefined },
    launcher: { launcherWarnings: () => [], answeredPipeEvent: () => {} },
    laneSetups: { noted: () => {} },
    tmuxStatusLines: { observe: () => {} },
  };
  // The cache's record of a delivered frame, heard on its way in.
  const recorded: string[][] = [];
  const record = rig.cache.delivered.bind(rig.cache);
  rig.cache.delivered = (sessionId, by, copies) => {
    recorded.push([...copies.values()]);
    record(sessionId, by, copies);
  };
  return { r: mainRenderer(parts), recorded };
}

// A statusline request for the rig's session, through the host's checkpoint.
// It passes a flag the client does not know, so its bar lists one error.
function checked(): CheckedRenderRequest {
  const configFile = path.join(dir, "config.json5");
  fs.writeFileSync(configFile, "{}");
  const { hookData } = requestOf(dir);
  const result = checkRenderRequest(
    {
      v: PROTOCOL_VERSION,
      kind: "render",
      hookData,
      args: ["cc-candybar", "--config", configFile, "--bogus"],
      cwd: PROJECT,
      encoding: "frame",
    },
    { firstSightOfUnknownHookField: () => false },
    () => {},
    dir,
  );
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.req;
}

const REQUEST = 7 as RequestId;

const request = (r: Renderer) =>
  r.answer({
    kind: "event",
    at: AT,
    event: {
      kind: "request",
      id: REQUEST,
      context: checked(),
      waitEndsAt: systemTimekeeper.monotonic() + 5_000,
    },
  });

const done = (r: Renderer, of: EffectId, ok: boolean) =>
  r.answer({
    kind: "event",
    at: AT,
    event: {
      kind: "effect-done",
      of,
      outcome: ok ? { kind: "ok" } : { kind: "failed", reason: "left" },
    },
  });

const presentOf = (effects: readonly Effect[]): Effect => {
  expect(effects).toHaveLength(1);
  return effects[0]!;
};

describe("a statusline request", () => {
  test("is answered by one present for the statusline, carrying its request and the drawn bar", async () => {
    const { effects, record } = await request(renderer().r);
    const present = presentOf(effects);
    expect(present).toMatchObject({
      kind: "present",
      surface: "statusline",
      session: SESSION,
      request: REQUEST,
    });
    expect(present.frame.rows.length).toBeGreaterThan(0);
    // The turn's record is the render event's renderer half.
    expect(new Map(record).get("sid")).toBe(SESSION);
    expect(new Map(record).has("drew")).toBe(true);
  });

  test("records what its frame showed only once the present's effect-done says it arrived", async () => {
    const { r, recorded } = renderer();
    const { effects } = await request(r);
    expect(recorded).toEqual([]);
    await done(r, presentOf(effects).id, true);
    expect(recorded).toEqual([[expect.stringMatching(/--bogus/)]]);
  });

  test("records nothing for a present its client never took, and hears of each present once", async () => {
    const { r, recorded } = renderer();
    const { id } = presentOf((await request(r)).effects);
    await done(r, id, false);
    expect(recorded).toEqual([]);
    await expect(done(r, id, true)).rejects.toThrow(TurnThrew);
    await expect(done(r, id, true)).rejects.toThrow(
      /not a present on its way/,
    );
  });
});
