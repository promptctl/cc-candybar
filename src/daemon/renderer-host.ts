// The host's one path to a renderer: every input it hands one passes through
// `deliver`, which answers with the turn's output or with how the turn failed,
// and never rejects.

import { inspect } from "node:util";
import {
  TurnThrew,
  type Renderer,
  type RendererInput,
  type RendererOutput,
  type TurnRecord,
} from "../renderer/interface.js";
import { valueOf } from "../utils/logfmt.js";
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

const line = (fields: TurnRecord): string =>
  `turn${fields.map(([key, value]) => ` ${key}=${valueOf(value)}`).join("")}`;

export function rendererHost(
  name: RendererName,
  renderer: Renderer,
  log: DaemonLogger,
): RendererHost {
  return {
    name,
    deliver: async (input, about) => {
      const { kind } = input.event;
      // [LAW:nothing-unseen] A request's turn is recorded on its render
      // event, by the request's answer; every other input's turn is recorded
      // here when it learned something or failed.
      const head: TurnRecord = [["renderer", name], ["input", kind], ...about];
      try {
        const output = await renderer.answer(input);
        if (kind !== "request" && output.record.length > 0)
          log("info", line([...head, ...output.record]));
        return { kind: "answered", output };
      } catch (e) {
        const threw =
          e instanceof TurnThrew
            ? { error: e.thrown, record: e.record }
            : { error: e, record: [] };
        // [LAW:no-silent-failure] No turn's failure is left unhandled.
        if (kind !== "request")
          log(
            "error",
            line([...head, ...threw.record, ["error", inspect(threw.error)]]),
          );
        return { kind: "threw", ...threw };
      }
    },
  };
}
