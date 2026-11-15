// [LAW:single-enforcer] The host proves every clicked link was drawn by this
// bar before a renderer sees it. Any web page can open a `cc-candybar://` link,
// so one that is forged, edited or unsigned reaches no renderer, whichever way
// it arrived, and its sender is told why.

import { systemTimekeeper } from "../src/time";
import { handleRequest, type HandledRequest } from "../src/daemon/reply";
import type { DaemonParts } from "../src/daemon/daemon-parts";
import { RuntimeStats } from "../src/daemon/stats";
import { ClicksInFlight } from "../src/daemon/clicks-in-flight";
import {
  classifyInbound,
  PROTOCOL_VERSION,
  URL_FRAME_KIND,
  URL_FRAME_VERSION,
  type Response,
} from "../src/daemon/foundations/protocol";
import { effectsUrl, STATUS_CLICK_URL, VERB_COPY } from "../src/click/wire";
import { badRequest } from "../src/daemon/foundations/verb-error";
import { keylessSigner, type LinkSigner } from "../src/click/link-signer";
import { TEST_SIGNER } from "./helpers/link-signer";

const DRAWN = TEST_SIGNER.signLink(
  effectsUrl([{ verb: VERB_COPY, args: ["the drawn text"] }]),
);
const lastFlipped = (link: string): string =>
  `${link.slice(0, -1)}${link.endsWith("A") ? "B" : "A"}`;

// The renderer's answer to every click it is handed: by default, it took it.
function host(
  answer: unknown = { kind: "answered", record: [] },
  links: LinkSigner = TEST_SIGNER,
) {
  const handed: unknown[] = [];
  const parts = {
    clock: systemTimekeeper,
    log: () => {},
    menuIdle: { clickArrived: () => {}, clickSettled: () => {} },
    frameFeeds: { latest: () => null },
    payloadProviders: {},
    collector: { holding: () => () => {}, clicked: () => {} },
    clicks: new ClicksInFlight(),
    links,
    renderer: {
      answer: async (input: unknown) => {
        handed.push(input);
        return answer;
      },
    },
  } as unknown as DaemonParts;
  const send = async (frame: Record<string, unknown>): Promise<Response> => {
    const handled: HandledRequest = await handleRequest(
      parts,
      classifyInbound(frame),
      () => false,
      new RuntimeStats(systemTimekeeper).accept(),
      () => false,
    );
    if (handled.kind !== "reply") throw new Error("a click opened a stream");
    return handled.resp;
  };
  const viaForwarder = (url: string) =>
    send({ kind: URL_FRAME_KIND, urlV: URL_FRAME_VERSION, url });
  const viaCli = (url: string) =>
    send({ v: PROTOCOL_VERSION, kind: "click", url });
  return { handed, viaForwarder, viaCli };
}

describe.each([
  ["the URL handler", "viaForwarder"],
  ["`cc-candybar url-handle`", "viaCli"],
] as const)("a link delivered by %s", (_by, via) => {
  test("drawn by this bar reaches the renderer as the link it drew", async () => {
    const rig = host();
    expect(await rig[via](DRAWN)).toEqual({ ok: true, output: "" });
    expect(rig.handed).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ kind: "click", verb: "dispatch" }),
      }),
    ]);
  });

  test.each([
    [
      "with no mac",
      effectsUrl([{ verb: VERB_COPY, args: ["a page's text"] }]),
      /carries no signature/,
    ],
    ["whose mac is changed", lastFlipped(DRAWN), /does not match/],
    [
      "whose words are changed",
      DRAWN.replace("drawn", "forged"),
      /does not match/,
    ],
  ])(
    "%s reaches no renderer, and is refused saying why",
    async (_what, url, why) => {
      const rig = host();
      expect(await rig[via](url)).toMatchObject({
        ok: false,
        code: "BAD_REQUEST",
        error: expect.stringMatching(why),
      });
      expect(rig.handed).toEqual([]);
    },
  );

  // A link that names no session has no bar to hold its failure, so its
  // sender is told, whichever way it came.
  test("whose verb fails in its turn is told the failure", async () => {
    const rig = host({
      kind: "threw",
      record: [],
      failure: badRequest("unknown click verb: gone-verb"),
    });
    expect(await rig[via](DRAWN)).toMatchObject({
      ok: false,
      code: "BAD_REQUEST",
      error: "unknown click verb: gone-verb",
    });
  });
});

// A host whose key file is broken still boots, and says why on every click.
test("a host with no link key refuses each click, saying why", async () => {
  const rig = host(undefined, keylessSigner("link key /s/link.key holds 3 bytes"));
  expect(await rig.viaForwarder(DRAWN)).toMatchObject({
    ok: false,
    code: "BAD_REQUEST",
    error: expect.stringMatching(/link key \/s\/link.key holds 3 bytes/),
  });
  expect(rig.handed).toEqual([]);
});

// A range is tmux's to send: it expands one from its binding at the click, so
// one carries no mac, and one through the URL handler came from a page.
test("a status-line range delivered by the URL handler reaches no renderer, and is refused", async () => {
  const rig = host();
  expect(
    await rig.viaForwarder(`${STATUS_CLICK_URL}default/0/ccb0123456789ab`),
  ).toMatchObject({
    ok: false,
    code: "BAD_REQUEST",
    error: expect.stringMatching(/tmux's click binding/),
  });
  expect(rig.handed).toEqual([]);
});

// The forwarder of this version waits for its answer and shows a refusal; one
// of the version before it hangs up unread, so it is answered nothing.
describe("the URL handler's frame", () => {
  test("of this version is one its writer waits on", () => {
    expect(
      classifyInbound({
        kind: URL_FRAME_KIND,
        urlV: URL_FRAME_VERSION,
        url: DRAWN,
      }),
    ).toMatchObject({ kind: "url", answered: "outcome" });
  });

  test("of the version before is one its writer hangs up on", () => {
    expect(
      classifyInbound({ kind: URL_FRAME_KIND, urlV: 1, url: DRAWN }),
    ).toMatchObject({ kind: "url", answered: "never" });
  });
});
