// A recording a write ends lets go of the view it was following: no line is
// offered to its sink after the end, whichever write it was that failed.

import { observable, runInAction } from "mobx";
import type { FactsLine, RecordingLine } from "../../src/facts/recording";
import type { ViewFacts } from "../../src/daemon/render-payload";
import {
  sessionRecorder,
  type DrawnFrom,
} from "../../src/daemon/session-recorder";
import { sessionIdOf } from "../../src/daemon/session-id";
import type { Instant } from "../../src/utils/instant";

const SID = sessionIdOf("rec-session");

// A view whose document and declaration the test moves. The recorder only
// passes them on, so each is a stand-in.
function view(name = "a") {
  const line = observable.box({
    at: 1,
    facts: { seq: 1 },
  } as unknown as FactsLine);
  let declaration = { name } as unknown as ViewFacts;
  return {
    followed: { stamped: () => line.get(), failure: () => null },
    source: { home: () => "/home/recorded" },
    // What a draw of it reads.
    drawn: (): DrawnFrom => ({ document: line.get(), declaration }),
    declare: (next: string) => {
      declaration = { name: next } as unknown as ViewFacts;
    },
    move: (seq: number) =>
      runInAction(() =>
        line.set({ at: seq, facts: { seq } } as unknown as FactsLine),
      ),
  };
}

// A sink whose facts writes throw, counting what it was offered and how it
// ended.
function failingSink() {
  const offered: RecordingLine["kind"][] = [];
  const ended: unknown[] = [];
  return {
    offered,
    ended,
    sink: {
      write: (line: RecordingLine) => {
        offered.push(line.kind);
        if (line.kind === "facts") throw new Error("ENOSPC");
      },
      end: (failure: unknown) => ended.push(failure),
    },
  };
}

test("a recording whose first document fails to write is ended, and its view's next document is offered to no one", () => {
  const v = view();
  const recorder = sessionRecorder({ sessionView: () => v }, () => {});
  const { sink, offered, ended } = failingSink();
  recorder.record(SID, sink);
  expect(offered).toEqual(["recording", "facts"]);
  expect(ended).toEqual([{ kind: "failed", error: new Error("ENOSPC") }]);
  v.move(2);
  expect(offered).toEqual(["recording", "facts"]);
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
  expect(offered).toEqual(["recording", "facts", "facts"]);
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

test("a draw is written after what it read: its document and declaration again, when the recording's last are another view's, as a request's held view the session moved away from", () => {
  const first = view("a");
  const second = view("b");
  let current = first;
  const recorder = sessionRecorder({ sessionView: () => current }, () => {});
  const { lines, sink } = keepingSink();
  recorder.record(SID, sink);
  const a = recorder.arrived(SID, {
    at: AT,
    request: first.drawn().declaration,
  });
  // A draw of what the recording last wrote: the draw line alone.
  recorder.drew(SID, a, first.drawn());
  // A second request moves the session to another view while the first's
  // still holds its own: the first is drawn from a document of that view the
  // recording never followed, and with its own declaration.
  current = second;
  recorder.moved(SID);
  const b = recorder.arrived(SID, {
    at: AT,
    request: second.drawn().declaration,
  });
  first.move(3);
  recorder.drew(SID, a, first.drawn());
  // The next draw, from the view the session is on, restates both.
  recorder.drew(SID, b, second.drawn());
  const shape = lines
    .slice(1)
    .map((line) =>
      line.kind === "facts"
        ? `facts ${String(line.facts.seq)}`
        : line.kind === "declared"
          ? `declared ${String((line.request as unknown as { name: string }).name)}`
          : line.kind,
    );
  expect(shape).toEqual([
    "facts 1",
    "request",
    "draw",
    "facts 1",
    "request",
    "facts 3",
    "declared a",
    "draw",
    "facts 1",
    "declared b",
    "draw",
  ]);
  expect(lines.at(-1)).toEqual({ kind: "draw", request: AT });
});

test("a draw whose document fails to write ends the recording, and no draw line is offered", () => {
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
  const a = recorder.arrived(SID, { at: AT, request: v.drawn().declaration });
  failing = true;
  const other = view();
  other.move(4);
  recorder.drew(SID, a, other.drawn());
  expect(offered).toEqual(["recording", "facts", "request", "facts"]);
  expect(ended).toEqual([{ kind: "failed", error: new Error("EIO") }]);
});

test("a recording started during a request's wait is written no draw of that request, only of the ones it saw arrive", () => {
  const v = view();
  const recorder = sessionRecorder({ sessionView: () => v }, () => {});
  const before = keepingSink();
  recorder.record(SID, before.sink);
  const waiting = recorder.arrived(SID, {
    at: AT,
    request: v.drawn().declaration,
  });
  const during = keepingSink();
  recorder.record(SID, during.sink);
  recorder.drew(SID, waiting, v.drawn());
  const next = recorder.arrived(SID, {
    at: AT,
    request: v.drawn().declaration,
  });
  recorder.drew(SID, next, v.drawn());
  const kinds = (lines: RecordingLine[]) => lines.map((line) => line.kind);
  expect(kinds(before.lines)).toEqual([
    "recording",
    "facts",
    "request",
    "draw",
    "request",
    "draw",
  ]);
  expect(kinds(during.lines)).toEqual([
    "recording",
    "facts",
    "request",
    "draw",
  ]);
});
