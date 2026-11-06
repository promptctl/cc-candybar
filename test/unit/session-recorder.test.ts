// A recording a write ends lets go of the view it was following: no line is
// offered to its sink after the end, whichever write it was that failed.

import { observable, runInAction } from "mobx";
import type { FactsLine, RecordingLine } from "../../src/facts/recording";
import { sessionRecorder } from "../../src/daemon/session-recorder";
import { sessionIdOf } from "../../src/daemon/session-id";

const SID = sessionIdOf("rec-session");

// A view whose document the test moves. The recorder only passes the line
// on, so its document is a stand-in.
function view() {
  const line = observable.box({
    at: 1,
    facts: { seq: 1 },
  } as unknown as FactsLine);
  return {
    followed: { stamped: () => line.get(), failure: () => null },
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
