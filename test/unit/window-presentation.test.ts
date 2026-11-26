import {
  Presentation,
  readNativeMessage,
  type Message,
} from "../../src/bar-window/presentation";
import { renderFailedFrame, type WireFrame } from "../../src/render/frame";

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

test("a failed first or subsequent render replaces the controls and recovers with the next frame", () => {
  const messages: Message[] = [];
  const view = new Presentation((message) => messages.push(message));
  const press = (revision: number) =>
    view.link({ revision, at: { row: 0, run: 0 }, button: 0 });
  for (const [i, next] of [
    renderFailedFrame("initial draw"),
    frame("usable"),
    renderFailedFrame("later draw"),
    frame("restored"),
  ].entries()) {
    view.offer(next);
    view.presented(i + 1);
    expect(press(i)).toBeUndefined();
    expect(press(i + 1)).toBe(next.rows[0]!.runs[0]!.link);
  }
  expect(JSON.stringify(messages[0])).toContain("initial draw");
  expect(JSON.stringify(messages[2])).toContain("later draw");
});

test.each([
  { kind: "unavailable" },
  { kind: "presented", revision: 0 },
  { kind: "press", revision: 1, at: { row: 0, run: 0 }, button: 0 },
  { kind: "hover", revision: 1, at: { row: -1, run: 0 } },
])("rejects incomplete native event %j", (event) => {
  expect(() => readNativeMessage(JSON.stringify(event))).toThrow(
    "Invalid native window event",
  );
});
