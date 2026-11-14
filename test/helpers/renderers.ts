// Renderers a test builds around its own answer to events: one that answers
// events alone, and one that hears each event on its way into a real
// renderer. A push reaches neither test's answer.

import type {
  AdapterInput,
  AdapterOutput,
  EventInput,
  Renderer,
  RendererInput,
  RendererOutput,
} from "../../src/renderer-interface/interface";

// A renderer whose events `answered` answers, and which no push reaches.
export function eventRenderer(
  answered: (input: EventInput) => Promise<RendererOutput>,
): Renderer {
  function answer(input: EventInput): Promise<RendererOutput>;
  function answer(input: AdapterInput): Promise<AdapterOutput>;
  function answer(
    input: RendererInput,
  ): Promise<RendererOutput | AdapterOutput> {
    switch (input.kind) {
      case "event":
        return answered(input);
      case "adapter":
        throw new Error(`this renderer takes no push (${input.push.kind})`);
    }
  }
  return { answer };
}

// A renderer whose pushes `replied` answers, and which no event reaches.
export function pushRenderer(
  replied: (input: AdapterInput) => Promise<AdapterOutput>,
): Renderer {
  function answer(input: EventInput): Promise<RendererOutput>;
  function answer(input: AdapterInput): Promise<AdapterOutput>;
  function answer(
    input: RendererInput,
  ): Promise<RendererOutput | AdapterOutput> {
    switch (input.kind) {
      case "event":
        throw new Error(`this renderer takes no event (${input.event.kind})`);
      case "adapter":
        return replied(input);
    }
  }
  return { answer };
}

// The pushes of a rig that hands its renderer none: one would be the rig's
// bug, said.
export const NO_PUSHES = (): never => {
  throw new Error("this rig hands the renderer no push");
};

// `renderer`, with `heard` told each event before it answers.
export function hearingEvents(
  renderer: Renderer,
  heard: (input: EventInput) => void,
): Renderer {
  function answer(input: EventInput): Promise<RendererOutput>;
  function answer(input: AdapterInput): Promise<AdapterOutput>;
  function answer(
    input: RendererInput,
  ): Promise<RendererOutput | AdapterOutput> {
    switch (input.kind) {
      case "event":
        heard(input);
        return renderer.answer(input);
      case "adapter":
        return renderer.answer(input);
    }
  }
  return { answer };
}
