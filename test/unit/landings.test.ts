// A click across turns (src/renderer/landings.ts): its turn answers with its
// first change, each change's `effect-done` answers with the next stretch, and
// a failure after a landing is the failure of the turn that resumed it.

import type { SessionId } from "../../src/daemon/foundations/session-id";
import type { EffectId } from "../../src/renderer-interface/interface";
import { Landings } from "../../src/renderer/landings";

const SID = "s" as SessionId;
const CHANGE = [{ op: "remove", at: ["a"], read: 1 }] as const;

const landings = () => {
  let minted = 0;
  return new Landings(() => ++minted as EffectId);
};

test("a click that lands nothing answers its turn with no change", async () => {
  expect(await landings().run(async () => {})).toEqual([]);
});

test("each change's effect-done answers with the next, and the last with none", async () => {
  const l = landings();
  const heard: string[] = [];
  const first = await l.run(async (land) => {
    heard.push((await land(SID, CHANGE)).kind);
    heard.push((await land(SID, CHANGE)).kind);
  });
  expect(first.map((c) => c.id)).toEqual([1]);
  const second = await l.done(1 as EffectId, { kind: "ok" })!;
  expect(second.map((c) => c.id)).toEqual([2]);
  expect(
    await l.done(2 as EffectId, { kind: "refused", reason: "moved" })!,
  ).toEqual([]);
  expect(heard).toEqual(["ok", "refused"]);
});

test("a click that throws after a landing fails the turn that resumed it", async () => {
  const l = landings();
  await l.run(async (land) => {
    await land(SID, CHANGE);
    throw new Error("after landing");
  });
  await expect(l.done(1 as EffectId, { kind: "ok" })!).rejects.toThrow(
    "after landing",
  );
});

test("an effect-done no click waits on is no landing's", () => {
  expect(landings().done(9 as EffectId, { kind: "ok" })).toBeUndefined();
});
