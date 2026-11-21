// The daemon's one owner of a held event (src/daemon/held-slot.ts): the event
// stays while some bar can show it, and leaves once the hold rule says `over`
// for a request, whether its hold ends after an answer or an answer lands
// after its hold. Events that recur are held per subject, counted while held.

import {
  HeldSlot,
  RecurringEvents,
  recurrence,
} from "../../src/daemon/held-slot";
import {
  DAEMON_EVENT_HOLD_S,
  type HeldEvent,
} from "../../src/utils/event-hold";
import { instantAt } from "../../src/utils/instant";
import { heldClock } from "../helpers/held-clock";

const HOLD_MS = DAEMON_EVENT_HOLD_S * 1000;

function rig() {
  const clock = heldClock(new Date("2026-01-01T00:00:00Z"));
  let left = 0;
  const slot = new HeldSlot(clock, "test hold", () => left++);
  const event = (text: string, revision = 1): HeldEvent => ({
    text,
    at: instantAt(clock),
    revision,
    answered: false,
  });
  return { clock, slot, event, left: () => left };
}

test("an answered event leaves when its hold ends", () => {
  const { clock, slot, event, left } = rig();
  const shown = event("it broke");
  slot.hold(shown);
  expect(slot.answer(shown)).toBe(true);
  clock.advance(HOLD_MS - 1);
  expect(slot.event()).toEqual({ ...shown, answered: true });
  clock.advance(1);
  expect(slot.event()).toBeNull();
  expect(left()).toBe(1);
});

test("an event no answer carried stays owed past its hold, and leaves at the answer", () => {
  const { clock, slot, event, left } = rig();
  const shown = event("it broke");
  slot.hold(shown);
  clock.advance(HOLD_MS * 3);
  expect(slot.event()).toEqual(shown);
  expect(left()).toBe(0);
  expect(slot.answer(shown)).toBe(true);
  expect(slot.event()).toBeNull();
  expect(left()).toBe(1);
});

test("an earlier occurrence's hold end never retires the one held after it", () => {
  const { clock, slot, event, left } = rig();
  const first = event("it broke");
  slot.hold(first);
  slot.answer(first);
  clock.advance(HOLD_MS / 2);
  const second = event("it broke", 2);
  slot.hold(second);
  slot.answer(second);
  clock.advance(HOLD_MS / 2);
  expect(slot.event()).toEqual({ ...second, answered: true });
  clock.advance(HOLD_MS / 2);
  expect(slot.event()).toBeNull();
  expect(left()).toBe(1);
});

test("an answer that carried an older occurrence marks nothing", () => {
  const { slot, event } = rig();
  const first = event("it broke");
  slot.hold(first);
  slot.hold(event("it broke", 2));
  expect(slot.answer(first)).toBe(false);
});

test("a disposed slot arms nothing, and holds nothing after", () => {
  const { clock, slot, event } = rig();
  slot.hold(event("it broke"));
  slot.dispose();
  expect(clock.pending()).toBe(0);
  slot.hold(event("past the close"));
  expect(slot.event()).toBeNull();
  expect(clock.pending()).toBe(0);
});

test("a hold end the wall reading has not reached arms again for what is left, so the slot still leaves", () => {
  const timers = heldClock(new Date("2026-01-01T00:00:00Z"));
  // The wall reading steps back while the hold's timer runs on.
  let skew = 0;
  const clock = { ...timers, now: () => timers.now() - skew };
  let left = 0;
  const slot = new HeldSlot(clock, "test hold", () => left++);
  const shown: HeldEvent = {
    text: "it broke",
    at: instantAt(clock),
    revision: 1,
    answered: false,
  };
  slot.hold(shown);
  slot.answer(shown);
  skew = 2_000;
  timers.advance(HOLD_MS);
  expect(slot.event()).toEqual({ ...shown, answered: true });
  expect(timers.pending()).toBe(1);
  timers.advance(2_000);
  expect(slot.event()).toBeNull();
  expect(left).toBe(1);
});

test("an event that leaves at an answer past its hold arms nothing more", () => {
  const { clock, slot, event } = rig();
  const shown = event("it broke");
  slot.hold(shown);
  clock.advance(HOLD_MS);
  slot.answer(shown);
  expect(clock.pending()).toBe(0);
});

// A family of recurring events over the held clock, whose shown events say
// how often each recurred, and what it held after each change.
function recurring() {
  const clock = heldClock(new Date("2026-01-01T00:00:00Z"));
  const heard: string[][] = [];
  const events: RecurringEvents<{ about: string; said: string }> =
    new RecurringEvents(
      clock,
      "launch-pipes",
      "test hold",
      ({ about }) => about,
      ({ said }, more) => ({
        text: `${said}${recurrence(more)}`,
        at: instantAt(clock),
        revision: 1,
        answered: false,
      }),
      () => heard.push(texts()),
    );
  const texts = () => events.held().map(({ event }) => event.text);
  return { clock, events, heard, texts };
}

test("an occurrence while its subject is held is counted, and the latest is held afresh with its count when the slot lets go", () => {
  const { clock, events, texts } = recurring();
  events.occur({ about: "cut", said: "cut" });
  events.occur({ about: "cut", said: "cut early" });
  events.occur({ about: "cut", said: "cut late" });
  expect(texts()).toEqual(["cut"]);
  clock.advance(HOLD_MS);
  // Owed: no answer carried it, so it stays past its hold.
  expect(texts()).toEqual(["cut"]);
  const [held] = events.held();
  expect(events.answer("cut", held!.event)).toBe(true);
  expect(texts()).toEqual(["cut late 2 more times"]);
});

test("each subject is held apart, so one never stands for another", () => {
  const { events, texts } = recurring();
  events.occur({ about: "cut", said: "cut" });
  events.occur({ about: "unread", said: "unread" });
  events.occur({ about: "cut", said: "cut" });
  expect(events.held()).toEqual([
    expect.objectContaining({ kind: "launch-pipes", about: "cut" }),
    expect.objectContaining({ kind: "launch-pipes", about: "unread" }),
  ]);
  expect(texts()).toEqual(["cut", "unread"]);
  // An answer is about one subject: another's event marks nothing.
  const [cut] = events.held();
  expect(events.answer("unread", cut!.event)).toBe(false);
});

test("a subject with nothing recurred leaves every bar when its slot lets go", () => {
  const { clock, events, heard } = recurring();
  events.occur({ about: "cut", said: "cut" });
  const [held] = events.held();
  events.answer("cut", held!.event);
  clock.advance(HOLD_MS);
  expect(events.held()).toEqual([]);
  expect(heard).toEqual([["cut"], []]);
  // Its next occurrence is held as a first one.
  events.occur({ about: "cut", said: "cut" });
  expect(heard.at(-1)).toEqual(["cut"]);
});

test("what recurred reaches the event it is shown as at the close, and nothing is held after", () => {
  const shown: number[] = [];
  const clock = heldClock(new Date("2026-01-01T00:00:00Z"));
  const events = new RecurringEvents<string>(
    clock,
    "task-threw",
    "test hold",
    (about) => about,
    (said, more) => {
      shown.push(more);
      return { text: said, at: instantAt(clock), answered: false };
    },
    () => {},
  );
  events.occur("sweep");
  events.occur("sweep");
  events.dispose();
  expect(shown).toEqual([0, 1]);
  expect(events.held()).toEqual([]);
  expect(clock.pending()).toBe(0);
});
