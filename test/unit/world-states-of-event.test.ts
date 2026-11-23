// [LAW:types-are-the-program] The world states a renderer's turn takes are
// named by the event that carries them, so the host ends each one's turn
// without a list of kinds of its own.

import { worldStatesOf, type Event } from "../../src/renderer-interface/interface";
import { worldStateOf } from "../helpers/world-state";

const START_WITH = (...seqs: number[]): Event =>
  ({
    kind: "start",
    viewers: {},
    configs: [],
    sessions: seqs.map((seq) => ({
      context: {} as never,
      worldState: worldStateOf({ seq }),
    })),
  }) as unknown as Event;

describe("the world states an event hands the renderer to take", () => {
  test("a world-state and a context carry their one", () => {
    const worldState = worldStateOf({ seq: 4 });
    expect(worldStatesOf({ kind: "world-state", worldState })).toEqual([
      worldState,
    ]);
    expect(
      worldStatesOf({ kind: "context", worldState } as unknown as Event),
    ).toEqual([worldState]);
  });

  test("a start carries each session's newest", () => {
    expect(worldStatesOf(START_WITH(3, 5)).map(({ seq }) => seq)).toEqual([
      3, 5,
    ]);
    expect(worldStatesOf(START_WITH())).toEqual([]);
  });

  test("an event that carries none names none", () => {
    expect(worldStatesOf({ kind: "due" })).toEqual([]);
  });
});
