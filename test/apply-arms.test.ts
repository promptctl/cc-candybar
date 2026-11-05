// Apply's table is exhaustive over the Event union: a new source of change does
// not build until its arm is written. The type checker holds the claim; the
// test names it and pins the table to the union's kinds.

import { ARMS, type ApplyArms, type Event } from "../src/daemon/apply";

type Widened = Event | { readonly kind: "extra" };

// @ts-expect-error -- no arm handles "extra", so the widened table is incomplete.
const incomplete: ApplyArms<Widened> = ARMS;

test("the arm table has one arm per kind of event, and no other", () => {
  const kinds: Record<Event["kind"], true> = {
    request: true,
    click: true,
    "menu-idle": true,
  };
  expect(Object.keys(ARMS).sort()).toEqual(Object.keys(kinds).sort());
  expect(incomplete).toBe(ARMS);
});
