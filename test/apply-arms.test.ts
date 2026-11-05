// Apply's table is exhaustive over the Event union: a new source of change does
// not build until its arm is written. The type checker holds the claim; the
// test names it and pins the table to the union's kinds.

import { ARMS, type ApplyArms, type Event } from "../src/daemon/apply";

type Widened = Event | { readonly kind: "extra" };

// The one arm a widened table asks for that ARMS lacks is exactly "extra":
// both directions of the equality fail to build if it is anything else.
type Missing = Exclude<keyof ApplyArms<Widened>, keyof typeof ARMS>;
const missing: Missing = "extra";
const onlyExtra: "extra" extends Missing
  ? Missing extends "extra"
    ? true
    : never
  : never = true;
// @ts-expect-error -- the arm named above is missing, so the table is incomplete.
const incomplete: ApplyArms<Widened> = ARMS;
void incomplete;

test("the arm table has one arm per kind of event, and no other", () => {
  const kinds: Record<Event["kind"], true> = {
    request: true,
    click: true,
    "menu-idle": true,
  };
  expect(Object.keys(ARMS).sort()).toEqual(Object.keys(kinds).sort());
  expect([missing, onlyExtra]).toEqual(["extra", true]);
});
