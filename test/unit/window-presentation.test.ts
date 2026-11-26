import { Presentation, type Message } from "../../src/bar-window/presentation";
import type { WireFrame } from "../../src/render/frame";

function frame(text: string): WireFrame<string> {
  return {
    rows: [
      {
        kind: "diagnostic",
        runs: [
          {
            text,
            link: "plain/" + text,
            region: {
              name: "action",
              gestures: { "ctrl+right": "modified/" + text },
            },
          },
        ],
      },
    ],
    depth: "truecolor",
    motion: "still",
    nextChange: null,
    pending: [],
  };
}

test("a slow WebKit page retains the displayed command and coalesces queued frames", () => {
  const writes: Message[] = [];
  const view = new Presentation((message) => writes.push(message));
  view.offer(frame("one"));
  view.presented(1);
  view.offer(frame("two"));
  view.offer(frame("three"));
  view.offer(frame("four"));
  const press = { at: { row: 0, run: 0 }, revision: 1, button: 0 };
  expect(writes.map((message) => message.revision)).toEqual([1, 2]);
  expect(view.link(press)).toBe("plain/one");
  expect(view.link({ ...press, revision: 2, button: 2, ctrl: true })).toBe(
    "modified/two",
  );
  view.presented(2);
  expect(view.link(press)).toBeUndefined();
  expect(writes.map((message) => message.revision)).toEqual([1, 2, 3]);
  expect(view.link({ ...press, revision: 3 })).toBe("plain/four");
  expect(view.link({ ...press, revision: 3, button: 2 })).toBeUndefined();
});
