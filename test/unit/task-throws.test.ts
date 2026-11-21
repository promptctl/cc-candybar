// Who takes what the daemon process's tasks throw (src/daemon/task-throws.ts):
// nobody yet, so each waits; the daemon, attached once, oldest first; and a
// log once no daemon can show them.

import {
  TaskThrowInbox,
  type ReportedThrow,
} from "../../src/daemon/task-throws";

const thrown = (task: string): [string, unknown, number] => [
  task,
  new Error(task),
  0,
];

test("throws before a taker wait, and reach it oldest first, ahead of one reported while they are taken", () => {
  const inbox = new TaskThrowInbox();
  inbox.report(...thrown("a"));
  inbox.report(...thrown("b"));
  const taken: string[] = [];
  inbox.attach(({ task }) => {
    taken.push(task);
    if (task === "a") inbox.report(...thrown("during"));
  });
  inbox.report(...thrown("after"));
  expect(taken).toEqual(["a", "b", "during", "after"]);
});

test("a second taker is refused, so the first never goes quiet unseen", () => {
  const inbox = new TaskThrowInbox();
  inbox.attach(() => {});
  expect(() => inbox.attach(() => {})).toThrow(
    "a throw inbox is already taken",
  );
});

test("once closed, a log takes what waits and what comes, and no taker attaches", () => {
  const inbox = new TaskThrowInbox();
  inbox.report(...thrown("before"));
  const logged: ReportedThrow[] = [];
  inbox.close((reported) => logged.push(reported));
  inbox.report(...thrown("on the way out"));
  expect(logged.map(({ task }) => task)).toEqual(["before", "on the way out"]);
  expect(() => inbox.attach(() => {})).toThrow(
    "a throw inbox is already closed",
  );
});

test("a daemon's close hands its throws to the log from then on", () => {
  const inbox = new TaskThrowInbox();
  const daemon: string[] = [];
  const logged: string[] = [];
  inbox.attach(({ task }) => daemon.push(task));
  inbox.report(...thrown("live"));
  inbox.close(({ task }) => logged.push(task));
  inbox.report(...thrown("closed"));
  expect([daemon, logged]).toEqual([["live"], ["closed"]]);
});
