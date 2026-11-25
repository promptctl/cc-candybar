// [LAW:verifiable-goals] What a session's transcripts gave its folds less of
// leaves the bar's figures for it short, so the session's bar says so: a ⚠ whose viewer
// names the file and why, for as long as the session's world state carries
// the loss, and gone once it does not. Driven through the main renderer as
// its host drives it, over in-memory storage.

import { clickOf } from "../../src/click/read";
import { admitClick } from "../../src/click/wire";
import type { TranscriptLoss } from "../../src/facts/world-state";
import { textOf } from "../../src/render/frame";
import type { RequestId } from "../../src/renderer-interface/interface";
import { pageOf, viewerLink } from "../helpers/diagnostics-viewer";
import { TEST_SIGNER } from "../helpers/link-signer";
import {
  answered,
  contextOf,
  handIn,
  indicatorLinkOf,
  presentOf,
  rendererOf,
  snapshotOf,
  worldStateOf,
} from "../helpers/main-renderer";

const CONFIG = `{
  segments: { said: { template: "said" } },
  root: { h: ["said"] },
}`;

test("a transcript's dropped lines and a sidechain whose owner cannot be told are each a ⚠ on the session's bar, until its world state no longer carries them", async () => {
  const r = rendererOf();
  const context = contextOf("s1");
  const session = context.hookData.session_id;
  const lines: TranscriptLoss = {
    kind: "dropped-lines",
    path: "/t/s1.jsonl",
    lines: 2,
    firstLine: 40,
    reason: "is not JSON (Unexpected token)",
  };
  const sidechain: TranscriptLoss = {
    kind: "unowned-sidechain",
    path: "/t/s1/subagents/agent-1.jsonl",
    reason: "names no session",
  };
  const clean = worldStateOf(session);
  answered(await handIn(r, { kind: "start", viewers: {}, sessions: [], configs: [] }));
  answered(
    await handIn(r, {
      kind: "context",
      context,
      worldState: {
        ...clean,
        transcriptLosses: [lines, sidechain],
      },
    }),
  );
  answered(
    await handIn(r, {
      kind: "config",
      origin: context.requested,
      config: snapshotOf(CONFIG),
    }),
  );
  let id = 0;
  const request = async () =>
    answered(
      await handIn(r, { kind: "request", id: ++id as RequestId, context }),
    );

  const indicator = indicatorLinkOf(presentOf((await request()).effects).frame);
  expect(indicator?.text).toBe("⚠ 2");

  const click = async (url: string) => {
    const { verb, value } = clickOf(url);
    answered(
      await handIn(r, {
        kind: "click",
        click: admitClick(verb, value, TEST_SIGNER).click,
        context: {
          session,
          durable: { origin: context.requested },
          live: context,
        },
      }),
    );
    return pageOf(presentOf((await request()).effects).frame);
  };
  const viewed = await click(indicator!.url);
  expect(viewed.position).toBe("1/2");
  expect(viewed.text).toBe(
    "⚠ /t/s1.jsonl: 2 lines could not be read, so the bar's figures for this session leave them out; the first, line 40, is not JSON (Unexpected token)",
  );
  const next = await click(viewerLink(viewed.rendered, "›")!.url);
  expect(next.position).toBe("2/2");
  expect(next.text).toBe(
    "⚠ /t/s1/subagents/agent-1.jsonl: its first line names no session, so whose sidechain it is cannot be told, and the session's usage leaves it out",
  );

  // A later world state that carries no loss leaves nothing to say.
  answered(
    await handIn(r, {
      kind: "world-state",
      worldState: { ...clean, seq: 2 },
    }),
  );
  const after = presentOf((await request()).effects).frame;
  expect(indicatorLinkOf(after)).toBeUndefined();
  expect(textOf(after)).not.toContain("could not be read");
});
