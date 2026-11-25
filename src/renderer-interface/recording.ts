import type { Crosses } from "./crosses.js";
import type {
  EventInput,
  RendererBoot,
  RendererConstruction,
  RendererOutput,
} from "./interface.js";
import type { RENDERER_WIRE_VERSION } from "./wire.js";

export const RECORDING_VERSION = 2;

// [LAW:effects-at-boundaries] A recording keeps the core's construction
// result and completed turns. PIDs, transport timing and host receipt names
// belong to the process that observed the turns.
export type RecordedConstruction =
  | Omit<Extract<RendererConstruction, { kind: "built" }>, "renderer">
  | Extract<RendererConstruction, { kind: "refused" }>;

export type RecordingEntry =
  | {
      readonly kind: "boot";
      readonly version: typeof RECORDING_VERSION;
      readonly wireVersion: typeof RENDERER_WIRE_VERSION;
      readonly input: RendererBoot;
      readonly result: RecordedConstruction;
    }
  | {
      readonly kind: "turn";
      readonly input: EventInput;
      readonly output: RendererOutput;
    }
  | { readonly kind: "end"; readonly turns: number };

export const RECORDING_CROSSES: Crosses<RecordingEntry> = true;
