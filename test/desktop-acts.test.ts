// The copy and open acts a click leaves to the desktop the person sits at
// belong to the click that asked them, by the id its arrival carries, so they
// reach that click's verdict and no other's.

import { DesktopActs } from "../src/daemon/desktop-acts";
import type { Act, EffectId } from "../src/renderer-interface/interface";
import type { DesktopClickId } from "../src/renderer-interface/click-arrival";
import { testActs } from "./helpers/click";

const copyFor = (
  click: DesktopClickId,
  text: string,
  id: number,
): Extract<Act, { kind: "desktop" }> => ({
  kind: "desktop",
  id: id as EffectId,
  session: null,
  click,
  act: { kind: "copy", text },
});

test("an act reaches the click that asked it, whichever click is answered first", () => {
  const acts = new DesktopActs();
  const first = acts.begin();
  const second = acts.begin();
  expect(acts.deposit(first, { kind: "copy", text: "a" })).toBe(true);
  expect(acts.deposit(second, { kind: "open", target: "/b" })).toBe(true);
  expect(acts.deposit(first, { kind: "copy", text: "c" })).toBe(true);
  expect(acts.end(second)).toEqual([{ kind: "open", target: "/b" }]);
  expect(acts.deposit(first, { kind: "copy", text: "d" })).toBe(true);
  expect(acts.end(first)).toEqual([
    { kind: "copy", text: "a" },
    { kind: "copy", text: "c" },
    { kind: "copy", text: "d" },
  ]);
});

test("an act asked after its click was answered is refused, not carried by another", () => {
  const acts = new DesktopActs();
  const answered = acts.begin();
  const waiting = acts.begin();
  acts.end(answered);
  expect(acts.deposit(answered, { kind: "copy", text: "late" })).toBe(false);
  expect(acts.end(waiting)).toEqual([]);
});

test("a click ended twice is the daemon's bug, said", () => {
  const acts = new DesktopActs();
  const click = acts.begin();
  acts.end(click);
  expect(() => acts.end(click)).toThrow(/ended twice/);
});

describe("the host's desktop act", () => {
  test("is left to the click's verdict and runs nothing on this machine", async () => {
    const desktop = new DesktopActs();
    const click = desktop.begin();
    const outcome = await testActs(() => {}, { desktop }).perform(
      copyFor(click, "/work/repo", 1),
    );
    expect(outcome).toEqual({ kind: "ok" });
    expect(desktop.end(click)).toEqual([{ kind: "copy", text: "/work/repo" }]);
  });

  test("fails by name when its click was already answered, so its renderer and bar hear it", async () => {
    const desktop = new DesktopActs();
    const click = desktop.begin();
    desktop.end(click);
    const outcome = await testActs(() => {}, { desktop }).perform(
      copyFor(click, "x", 2),
    );
    expect(outcome).toEqual({
      kind: "failed",
      reason: expect.stringContaining(
        "copy on the desktop: the click that asked it was already answered",
      ),
    });
  });
});
