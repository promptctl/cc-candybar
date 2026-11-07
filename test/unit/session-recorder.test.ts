// A recording a write ends lets go of the view it was following: no line is
// offered to its sink after the end, whichever write it was that failed. And a
// recording opens on the turn its bar is drawn from, and writes that turn
// again wherever its hold moves.

import { observable, runInAction } from "mobx";
import type {
  ClickState,
  DrawState,
  FactsLine,
  RecordingLine,
  SessionRequest,
} from "../../src/facts/recording";
import {
  sessionRecorder,
  type DrawnFrom,
} from "../../src/daemon/session-recorder";
import { sessionIdOf } from "../../src/daemon/session-id";
import type { Handed } from "../../src/daemon/draw-view";
import { ANSWERING, UNFOLLOWED_FEEDS } from "../../src/config/lanes";
import { EMPTY_HISTORY_DEPTH } from "../../src/daemon/settings-history";
import type { Instant } from "../../src/utils/instant";

const SID = sessionIdOf("rec-session");

// The session's clicks' state, which a turn is taken over and a draw reads.
const clicks: ClickState = {
  values: {},
  revision: 5,
  history: EMPTY_HISTORY_DEPTH,
  back: 0,
};

// What a draw of a view read of the session's state.
const state: DrawState = { ...clicks, idleSince: undefined };

// What an answer no lane follows is handed, and a lane's frame.
const ANSWERED: Handed = {
  drawing: ANSWERING,
  feeds: UNFOLLOWED_FEEDS,
  diagnostics: [],
};
const FED: Handed = {
  drawing: { by: "feed", fps: 30 },
  feeds: {
    ...UNFOLLOWED_FEEDS,
    pane: { subscribers: 1, fps: 30, shown: true },
  },
  diagnostics: [],
};

// A view whose document, declaration and hold the test moves. The recorder
// only passes them on, so each is a stand-in. Its turn is drawn from the
// document its follow holds, except while held: then from the one it held at.
function view(name = "a") {
  const line = observable.box({
    at: 1,
    facts: { seq: 1 },
  } as unknown as FactsLine);
  let declaration = { name } as unknown as SessionRequest;
  const held = observable.box<FactsLine | null>(null);
  const store = observable.box(clicks, { deep: false });
  const v = {
    followed: { stamped: () => line.get(), failure: () => null },
    facts: () => declaration,
    source: {
      home: () => "/home/recorded",
      state: () => store.get(),
      held: () => held.get() !== null,
      turn: () => ({
        document: held.get() ?? line.get(),
        request: declaration,
        state: clicks,
      }),
    },
    // What a draw of it reads.
    drawn: (handed: Handed = ANSWERED): DrawnFrom => ({
      view: v,
      state,
      ...handed,
    }),
    declare: (next: string) => {
      declaration = { name: next } as unknown as SessionRequest;
    },
    move: (seq: number) =>
      runInAction(() =>
        line.set({ at: seq, facts: { seq } } as unknown as FactsLine),
      ),
    click: (revision: number) =>
      runInAction(() =>
        store.set({ ...clicks, values: { picked: "on" }, revision }),
      ),
    hold: (on: boolean) => runInAction(() => held.set(on ? line.get() : null)),
  };
  return v;
}

// A line's document by its seq, and the kind of every other line.
const shapeOf = (lines: readonly RecordingLine[]): string[] =>
  lines.map((line) =>
    line.kind === "facts"
      ? `facts ${String(line.facts.seq)}`
      : line.kind === "turn"
        ? `turn ${String(line.document.facts.seq)}${line.held ? " held" : ""}`
        : line.kind === "declared"
          ? `declared ${String((line.request as unknown as { name: string }).name)}`
          : line.kind,
  );

// A sink whose document writes throw (a turn's and a facts line's), counting
// what it was offered and how it ended.
function failingSink() {
  const offered: RecordingLine["kind"][] = [];
  const ended: unknown[] = [];
  return {
    offered,
    ended,
    sink: {
      write: (line: RecordingLine) => {
        offered.push(line.kind);
        if (line.kind === "facts" || line.kind === "turn") {
          throw new Error("ENOSPC");
        }
      },
      end: (failure: unknown) => ended.push(failure),
    },
  };
}

test("a recording whose first document fails to write is ended, and its view's next document and turn are offered to no one", () => {
  const v = view();
  const recorder = sessionRecorder({ sessionView: () => v }, () => {});
  const { sink, offered, ended } = failingSink();
  recorder.record(SID, sink);
  expect(offered).toEqual(["recording", "turn"]);
  expect(ended).toEqual([{ kind: "failed", error: new Error("ENOSPC") }]);
  v.move(2);
  v.hold(true);
  expect(offered).toEqual(["recording", "turn"]);
});

test("a recording whose state line fails to write is ended, and the document stamped after the click is offered to no one", () => {
  const v = view();
  const recorder = sessionRecorder({ sessionView: () => v }, () => {});
  const offered: RecordingLine["kind"][] = [];
  const ended: unknown[] = [];
  recorder.record(SID, {
    write: (line) => {
      offered.push(line.kind);
      if (line.kind === "state") throw new Error("ENOSPC");
    },
    end: (failure) => ended.push(failure),
  });
  v.click(6);
  v.move(2);
  expect(offered).toEqual(["recording", "turn", "state"]);
  expect(ended).toEqual([{ kind: "failed", error: new Error("ENOSPC") }]);
});

test("a recording that fails on the document of the view it moved to is ended, and that view's next document is offered to no one", () => {
  const first = view();
  const second = view();
  let current = first;
  const recorder = sessionRecorder({ sessionView: () => current }, () => {});
  const offered: RecordingLine["kind"][] = [];
  const ended: unknown[] = [];
  let failing = false;
  recorder.record(SID, {
    write: (line) => {
      offered.push(line.kind);
      if (failing) throw new Error("EIO");
    },
    end: (failure) => ended.push(failure),
  });
  failing = true;
  current = second;
  recorder.moved(SID);
  expect(ended).toEqual([{ kind: "failed", error: new Error("EIO") }]);
  second.move(2);
  first.move(2);
  expect(offered).toEqual(["recording", "turn", "turn"]);
});

test("a view entered inside a batch is written from as the batch leaves it: a document it stamps before the batch ends is not lost", () => {
  const first = view();
  const second = view();
  let current = first;
  const recorder = sessionRecorder({ sessionView: () => current }, () => {});
  const seqs: unknown[] = [];
  recorder.record(SID, {
    write: (line) => {
      if (line.kind === "facts") seqs.push(line.facts.seq);
      if (line.kind === "turn") seqs.push(line.document.facts.seq);
    },
    end: () => {},
  });
  runInAction(() => {
    current = second;
    recorder.moved(SID);
    second.move(2);
  });
  expect(seqs).toEqual([1, 2]);
});

// A sink keeping every line it was offered.
function keepingSink() {
  const lines: RecordingLine[] = [];
  return {
    lines,
    sink: { write: (line: RecordingLine) => lines.push(line), end: () => {} },
  };
}

test("a click between documents is written as the session's state ahead of the next document, and a document under the same state carries none", () => {
  const v = view();
  const recorder = sessionRecorder({ sessionView: () => v }, () => {});
  const { lines, sink } = keepingSink();
  recorder.record(SID, sink);
  v.click(6);
  v.move(2);
  v.move(3);
  expect(shapeOf(lines.slice(1))).toEqual([
    "turn 1",
    "state",
    "facts 2",
    "facts 3",
  ]);
  expect(lines[2]).toEqual({
    kind: "state",
    state: { ...clicks, values: { picked: "on" }, revision: 6 },
  });
});

test("a view left in the batch it was entered in writes nothing: its reactions are disposed before their first run", () => {
  const first = view("a");
  const second = view("b");
  const third = view("c");
  let current = first;
  const recorder = sessionRecorder({ sessionView: () => current }, () => {});
  const { lines, sink } = keepingSink();
  recorder.record(SID, sink);
  runInAction(() => {
    current = second;
    recorder.moved(SID);
    current = third;
    recorder.moved(SID);
  });
  second.move(5);
  second.hold(true);
  expect(shapeOf(lines.slice(1))).toEqual(["turn 1", "turn 1"]);
  expect(lines[2]).toMatchObject({ request: third.facts() });
});

test("a recording stopped in the batch its view was entered in is offered no line after its end", () => {
  const first = view("a");
  const second = view("b");
  let current = first;
  const recorder = sessionRecorder({ sessionView: () => current }, () => {});
  const offered: string[] = [];
  const stop = recorder.record(SID, {
    write: (line) => offered.push(line.kind),
    end: () => offered.push("end"),
  });
  runInAction(() => {
    current = second;
    recorder.moved(SID);
    stop();
  });
  second.move(5);
  expect(offered).toEqual(["recording", "turn", "end"]);
});

test("a draw of a held view the session moved away from carries that view's held turn, and the current view's turn after it", () => {
  const first = view("a");
  const second = view("b");
  let current = first;
  const recorder = sessionRecorder({ sessionView: () => current }, () => {});
  const { lines, sink } = keepingSink();
  recorder.record(SID, sink);
  const a = recorder.arrived(SID, { at: AT, request: first.facts() });
  current = second;
  recorder.moved(SID);
  // The view the first request holds is held, and its follow stamps on.
  first.hold(true);
  first.move(3);
  recorder.drew(SID, a, () => first.drawn());
  expect(shapeOf(lines.slice(1))).toEqual([
    "turn 1",
    "request",
    "turn 1",
    "turn 1 held",
    "facts 3",
    "draw",
    "turn 1",
  ]);
  expect(lines[4]).toMatchObject({ held: true, request: first.facts() });
  expect(lines.at(-1)).toMatchObject({ held: false, request: second.facts() });
});

const AT = 1_700_000_000 as Instant;

test("the header names the home the recorded view's payloads are composed against", () => {
  const v = view();
  const recorder = sessionRecorder({ sessionView: () => v }, () => {});
  const { lines, sink } = keepingSink();
  recorder.record(SID, sink);
  expect(lines[0]).toEqual({
    kind: "recording",
    session: SID,
    home: "/home/recorded",
  });
});

test("a draw of a view the session moved away from is written between that view's turn and the current view's, so every line follows the turn of the view it came from", () => {
  const first = view("a");
  const second = view("b");
  let current = first;
  const recorder = sessionRecorder({ sessionView: () => current }, () => {});
  const { lines, sink } = keepingSink();
  recorder.record(SID, sink);
  const a = recorder.arrived(SID, {
    at: AT,
    request: first.facts(),
  });
  // A draw of what the recording last wrote: the draw line alone.
  recorder.drew(SID, a, () => first.drawn());
  // A second request moves the session to another view while the first's
  // still holds its own: the first is drawn from a document of that view the
  // recording never followed, and with its own declaration, which its turn
  // carries.
  current = second;
  recorder.moved(SID);
  const b = recorder.arrived(SID, {
    at: AT,
    request: second.facts(),
  });
  first.move(3);
  recorder.drew(SID, a, () => first.drawn());
  // The next draw, from the view the session is on, whose turn came last.
  recorder.drew(SID, b, () => second.drawn());
  expect(shapeOf(lines.slice(1))).toEqual([
    "turn 1",
    "request",
    "draw",
    "turn 1",
    "request",
    "turn 3",
    "draw",
    "turn 1",
    "draw",
  ]);
  expect(lines.at(-1)).toEqual({ kind: "draw", at: AT, state, ...ANSWERED });
});

test("a recording opens on its view's turn, and writes the turn again wherever its hold moves: the held turn as it begins, the turn taken as it ends", () => {
  const v = view("a");
  const recorder = sessionRecorder({ sessionView: () => v }, () => {});
  const { lines, sink } = keepingSink();
  recorder.record(SID, sink);
  const a = recorder.arrived(SID, { at: AT, request: v.facts() });
  recorder.drew(SID, a, () => v.drawn());
  v.hold(true);
  // The follow stamps on past the held turn's document.
  v.move(2);
  const b = recorder.arrived(SID, { at: AT, request: v.facts() });
  recorder.drew(SID, b, () => v.drawn());
  v.hold(false);
  expect(shapeOf(lines.slice(1))).toEqual([
    "turn 1",
    "request",
    "draw",
    "turn 1 held",
    "facts 2",
    "request",
    "draw",
    "turn 2",
  ]);
  // Each turn line carries the turn whole: its request and its clicks.
  expect(lines[4]).toMatchObject({
    kind: "turn",
    held: true,
    request: v.facts(),
    state: clicks,
  });
});

test("a draw whose first line fails to write ends the recording, and no draw line is offered", () => {
  const v = view();
  const recorder = sessionRecorder({ sessionView: () => v }, () => {});
  const offered: RecordingLine["kind"][] = [];
  const ended: unknown[] = [];
  let failing = false;
  recorder.record(SID, {
    write: (line) => {
      offered.push(line.kind);
      if (failing) throw new Error("EIO");
    },
    end: (failure) => ended.push(failure),
  });
  const a = recorder.arrived(SID, { at: AT, request: v.facts() });
  failing = true;
  const other = view();
  other.move(4);
  recorder.drew(SID, a, () => other.drawn());
  expect(offered).toEqual(["recording", "turn", "request", "turn"]);
  expect(ended).toEqual([{ kind: "failed", error: new Error("EIO") }]);
});

test("a recording started during a request's wait is written no draw of that request, only of the ones it saw arrive", () => {
  const v = view();
  const recorder = sessionRecorder({ sessionView: () => v }, () => {});
  const before = keepingSink();
  recorder.record(SID, before.sink);
  const waiting = recorder.arrived(SID, {
    at: AT,
    request: v.facts(),
  });
  const during = keepingSink();
  recorder.record(SID, during.sink);
  recorder.drew(SID, waiting, () => v.drawn());
  const next = recorder.arrived(SID, {
    at: AT,
    request: v.facts(),
  });
  recorder.drew(SID, next, () => v.drawn());
  const kinds = (lines: RecordingLine[]) => lines.map((line) => line.kind);
  expect(kinds(before.lines)).toEqual([
    "recording",
    "turn",
    "request",
    "draw",
    "request",
    "draw",
  ]);
  expect(kinds(during.lines)).toEqual(["recording", "turn", "request", "draw"]);
});

test("a lane's frame is written to every recording of the session, one started during a request's wait among them, as an answer's lines are", () => {
  const v = view();
  const recorder = sessionRecorder({ sessionView: () => v }, () => {});
  const before = keepingSink();
  recorder.record(SID, before.sink);
  const waiting = recorder.arrived(SID, { at: AT, request: v.facts() });
  const during = keepingSink();
  recorder.record(SID, during.sink);
  // The follow stamps and the view is declared again before the lane draws.
  v.move(2);
  v.declare("b");
  const framedAt = (AT + 0.0337) as Instant;
  recorder.fed(SID, framedAt, () => v.drawn(FED));
  recorder.drew(SID, waiting, () => v.drawn());
  expect(shapeOf(before.lines.slice(1))).toEqual([
    "turn 1",
    "request",
    "facts 2",
    "declared b",
    "draw",
    "draw",
  ]);
  expect(shapeOf(during.lines.slice(1))).toEqual([
    "turn 1",
    "facts 2",
    "declared b",
    "draw",
  ]);
  expect(during.lines.at(-1)).toEqual({
    kind: "draw",
    at: framedAt,
    state,
    ...FED,
  });
});
