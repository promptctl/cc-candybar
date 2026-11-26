import { admitClick } from "../../src/click/wire";
// [LAW:verifiable-goals] A placement that cannot draw shows its ⚠ cell, and
// its whole message reaches the two places a reader without the cell looks:
// the bar's ⚠ list, whose viewer shows it, and the turn record, whose
// `faults` note lists it once and says `kept` while nothing moved. Driven
// through the main renderer as its host drives it, over in-memory storage.

import { clickOf } from "../../src/click/read";
import { PRESET_FLOOR } from "../../src/config/presets";
import { textOf } from "../../src/render/frame";
import type {
  RendererOutput,
  RequestId,
} from "../../src/renderer-interface/interface";
import { readFaults } from "../../src/renderer-interface/noted-faults";
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

const MESSAGE = "the placement broke on purpose";
const CONFIG = `{
  segments: { broken: { template: '{{ fail "${MESSAGE}" }}' } },
  root: { h: ["broken"] },
}`;

const noted = (output: RendererOutput, field: string): string => {
  const found = output.record.find(([key]) => key === field);
  if (found === undefined) throw new Error(`the record notes no ${field}`);
  return String(found[1]);
};

test("a placement's error draws its ⚠ cell, reaches the ⚠ list in full, and is noted once in the turn record", async () => {
  const r = rendererOf();
  const context = contextOf("s1");
  const session = context.hookData.session_id;
  answered(await handIn(r, { kind: "start", viewers: {}, sessions: [], configs: [] }));
  answered(
    await handIn(r, {
      kind: "context",
      context,
      worldState: worldStateOf(session),
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
  const settle = async (output: RendererOutput, delivered: boolean) =>
    answered(
      await handIn(r, {
        kind: "effect-done",
        session,
        of: presentOf(output.effects).id,
        outcome: delivered
          ? { kind: "ok" }
          : { kind: "failed", reason: "client disconnected" },
      }),
    );

  const first = await request();
  expect(textOf(presentOf(first.effects).frame)).toContain(`⚠ broken:`);
  expect(readFaults(noted(first, "faults"))).toContainEqual({
    level: "warning",
    kind: "segment",
    subject: "broken",
    message: `segment "broken": ${MESSAGE}`,
  });
  expect(noted(first, "warn")).toContain("segment:broken");
  // A config naming no preset draws the floor, and the record says which.
  expect(noted(first, "preset")).toBe(PRESET_FLOOR);
  await settle(first, false);

  const delivered = await request();
  expect(noted(delivered, "faults")).toBe(noted(first, "faults"));
  expect(indicatorLinkOf(presentOf(delivered.effects).frame)).toBeUndefined();
  await settle(delivered, true);

  // Nothing moved: the record says so, and the bar's list, which follows
  // the frames, now counts the warning.
  const second = await request();
  expect(noted(second, "faults")).toBe("kept");
  const indicator = indicatorLinkOf(presentOf(second.effects).frame);
  expect(indicator?.text).toBe("⚠ 1");
  await settle(second, true);

  // The indicator's click opens the viewer, which shows the whole message.
  const { verb, value } = clickOf(indicator!.url);
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
  const viewed = textOf(presentOf((await request()).effects).frame);
  expect(viewed).toContain("[1/1]");
  expect(viewed).not.toContain("⚠ broken:");
  expect(viewed).toContain(`⚠ segment "broken": ${MESSAGE}`);
});
