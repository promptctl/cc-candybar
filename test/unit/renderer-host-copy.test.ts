// The host performs a click's copy (src/daemon/renderer-host.ts): it writes
// the copy's text through its clipboard and hands the outcome back to the
// renderer as the copy's `effect-done`, on a turn of its own, before the
// click's turn settles. A copy any other turn returns is refused, never
// written.
//
// [LAW:behavior-not-structure] A scripted renderer and a fake clipboard; what
// is asserted is what reached each.

import { rendererHost } from "../../src/daemon/renderer-host";
import type { SessionId } from "../../src/daemon/session-id";
import {
  TurnThrew,
  type Effect,
  type EffectId,
  type EffectOutcome,
  type Event,
  type Renderer,
  type RendererOutput,
} from "../../src/renderer/interface";
import { instantAt } from "../../src/utils/instant";

// A unit test reads no clock: the host stamps its turns by this one.
const CLOCK = { monotonic: () => 0, now: () => 1_700_000_000_000 };
const SESSION = "sid-copy" as SessionId;
const COPY: Effect = { kind: "copy", id: 1 as EffectId, text: "the text" };
const NOTHING_READ = { sources: new Map() };

const output = (effects: readonly Effect[]): RendererOutput => ({
  effects,
  subscriptions: NOTHING_READ,
  record: [],
});

// A renderer whose click turn ends as `clicked` says, and which hears every
// other event without effect.
function scripted(clicked: () => RendererOutput) {
  const heard: Event[] = [];
  const renderer: Renderer = {
    answer: async ({ event }) => {
      heard.push(event);
      return event.kind === "click" ? clicked() : output([]);
    },
  };
  return { renderer, heard };
}

// The host over `renderer` and a clipboard that answers `outcome`, with what
// the clipboard was handed.
function host(renderer: Renderer, outcome: EffectOutcome) {
  const written: string[] = [];
  const h = rendererHost(
    "main",
    CLOCK,
    renderer,
    () => {},
    async (text) => {
      written.push(text);
      return outcome;
    },
    { subscribed: () => {}, holding: () => () => {} },
  );
  return { h, written };
}

const event = (e: Event) => ({
  kind: "event" as const,
  at: instantAt(CLOCK),
  event: e,
});

const click: Event = {
  kind: "click",
  verb: "dispatch",
  value: "",
  session: null,
  arrival: { via: "link", delivery: { kind: "cli" } },
  gone: () => false,
};

const doneOf = (heard: readonly Event[]) =>
  heard.filter((e) => e.kind === "effect-done");

test("a click's copy is written, and its effect-done reaches the renderer before the click settles", async () => {
  const { renderer, heard } = scripted(() => output([COPY]));
  const { h, written } = host(renderer, { kind: "ok" });
  await h.answer(event(click));
  expect(written).toEqual(["the text"]);
  expect(doneOf(heard)).toEqual([
    {
      kind: "effect-done",
      session: null,
      of: COPY.id,
      outcome: { kind: "ok" },
    },
  ]);
});

test("a copy the clipboard could not write comes back failed, in the clipboard's words", async () => {
  const { renderer, heard } = scripted(() => output([COPY]));
  const failed = { kind: "failed", reason: "pbcopy exited 1" } as const;
  const { h } = host(renderer, failed);
  await h.answer(event(click));
  expect(doneOf(heard)).toMatchObject([{ of: COPY.id, outcome: failed }]);
});

test("a click turn that threw after its act copied still has the copy written", async () => {
  const { renderer, heard } = scripted(() => {
    throw new TurnThrew([], new Error("a later step broke"), NOTHING_READ, [
      COPY,
    ]);
  });
  const { h, written } = host(renderer, { kind: "ok" });
  const delivered = await h.answer(event(click));
  expect(delivered.kind).toBe("threw");
  expect(written).toEqual(["the text"]);
  expect(doneOf(heard)).toMatchObject([
    { of: COPY.id, outcome: { kind: "ok" } },
  ]);
});

test("a copy from a turn that is no click is refused, and the clipboard is never handed it", async () => {
  const heard: Event[] = [];
  const renderer: Renderer = {
    answer: async ({ event: e }) => {
      heard.push(e);
      return output(e.kind === "menu-idle" ? [COPY] : []);
    },
  };
  const { h, written } = host(renderer, { kind: "ok" });
  await h.answer(
    event({ kind: "menu-idle", session: SESSION, idle: {} as never }),
  );
  expect(written).toEqual([]);
  expect(doneOf(heard)).toEqual([
    {
      kind: "effect-done",
      session: null,
      of: COPY.id,
      outcome: { kind: "failed", reason: "a menu-idle turn returns no copy" },
    },
  ]);
});
