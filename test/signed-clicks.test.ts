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
import { effectsUrl, VERB_COPY } from "../src/click/wire";
import { TEST_SIGNER } from "./helpers/link-signer";

const DRAWN = TEST_SIGNER.signLink(
  effectsUrl([{ verb: VERB_COPY, args: ["the drawn text"] }]),
);
const lastFlipped = (link: string): string =>
  `${link.slice(0, -1)}${link.endsWith("A") ? "B" : "A"}`;

function host() {
  const handed: unknown[] = [];
  const parts = {
    clock: systemTimekeeper,
    log: () => {},
    menuIdle: { clickArrived: () => {}, clickSettled: () => {} },
    frameFeeds: { latest: () => null },
    payloadProviders: {},
    collector: { holding: () => () => {}, clicked: () => {} },
    clicks: new ClicksInFlight(),
    links: TEST_SIGNER,
    renderer: {
      answer: async (input: unknown) => {
        handed.push(input);
        return { kind: "answered", record: [] };
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
    ).toMatchObject({ kind: "url", waits: true });
  });

  test("of the version before is one its writer hangs up on", () => {
    expect(
      classifyInbound({ kind: URL_FRAME_KIND, urlV: 1, url: DRAWN }),
    ).toMatchObject({ kind: "url", waits: false });
  });
});
