// The session's one idle record across the surfaces a turn draws
// (src/renderer-interface/presentation.ts), which the host's book and the
// renderer's records both keep: every surface drawn at one order shares it,
// and a draw at an earlier order moves nothing.

import { idleOfDraw } from "../../src/renderer-interface/presentation";
import type { Tick } from "../../src/utils/instant";

const menu = (tick: number, shown: boolean) => ({
  tick: tick as Tick,
  shown,
  timeoutS: 30,
});

test("a surface whose menu is closed keeps open a menu another surface drew at the same order, in either order", () => {
  const paneFirst = idleOfDraw(
    idleOfDraw(undefined, 2, menu(5, true)),
    2,
    menu(5, false),
  );
  expect(paneFirst).toEqual({
    order: 2,
    value: { since: 5, shown: true, timeoutS: 30 },
  });
  const windowFirst = idleOfDraw(
    idleOfDraw(undefined, 2, menu(5, false)),
    2,
    menu(5, true),
  );
  expect(windowFirst).toEqual(paneFirst);
});

test("a later order's closed menu closes it, and an earlier order moves nothing", () => {
  const open = idleOfDraw(undefined, 2, menu(5, true));
  const closed = idleOfDraw(open, 3, menu(6, false));
  expect(closed.value.shown).toBe(false);
  expect(idleOfDraw(closed, 2, menu(7, true))).toBe(closed);
});
