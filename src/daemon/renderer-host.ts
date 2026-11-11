// The host's one path to a renderer: every input it hands one passes through
// `deliver`, which answers with the turn's output or with how the turn failed:
// a turn's throw comes back as a value, never as a rejection. Every output's
// subscriptions are taken here, in the order the turns answered.

import { inspect } from "node:util";
import {
  TurnThrew,
  type Renderer,
  type RendererInput,
  type RendererOutput,
  type Subscriptions,
  type TurnRecord,
} from "../renderer/interface.js";
import { eventLine } from "../utils/logfmt.js";
import type { DaemonLogger } from "../utils/logger";

// The only renderer there is yet: the main one, in process.
export type RendererName = "main";

export type Delivered =
  | { readonly kind: "answered"; readonly output: RendererOutput }
  | {
      readonly kind: "threw";
      readonly error: unknown;
      // What the turn learned before it threw.
      readonly record: TurnRecord;
    };

export interface RendererHost {
  readonly name: RendererName;
  // `about` is what the host knows of the input, for the line a turn it does
  // not otherwise record writes.
  deliver(input: RendererInput, about: TurnRecord): Promise<Delivered>;
}

export function rendererHost(
  name: RendererName,
  renderer: Renderer,
  log: DaemonLogger,
  // [LAW:single-enforcer] Where every output's subscriptions go: the
  // collector, which diffs each whole set against the last.
  subscribed: (subscriptions: Subscriptions) => void,
): RendererHost {
  const turn = async (input: RendererInput): Promise<Delivered> => {
    try {
      const output = await renderer.answer(input);
      subscribed(output.subscriptions);
      return { kind: "answered", output };
    } catch (e) {
      return e instanceof TurnThrew
        ? { kind: "threw", error: e.thrown, record: e.record }
        : { kind: "threw", error: e, record: [] };
    }
  };
  // A turn's line, when it learned something or failed.
  const record = (
    input: RendererInput,
    about: TurnRecord,
    delivered: Delivered,
  ): void => {
    const head: TurnRecord = [
      ["renderer", name],
      ["input", input.event.kind],
      ...about,
    ];
    switch (delivered.kind) {
      case "answered":
        if (delivered.output.record.length > 0)
          log("info", eventLine("turn", [...head, ...delivered.output.record]));
        return;
      case "threw":
        // [LAW:no-silent-failure] No turn's failure is left unhandled.
        log(
          "error",
          eventLine("turn", [
            ...head,
            ...delivered.record,
            ["error", inspect(delivered.error)],
          ]),
        );
    }
  };
  return {
    name,
    deliver: async (input, about) => {
      const delivered = await turn(input);
      // [LAW:nothing-unseen] A request's turn is recorded on its render
      // event, by the request's answer; every other input's turn, here.
      if (input.event.kind !== "request") record(input, about, delivered);
      return delivered;
    },
  };
}
