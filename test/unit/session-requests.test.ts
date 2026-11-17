// The host's one book of each session's newest request
// (src/daemon/session-requests.ts): what a start opens a session at, what a
// click and a status row read, kept across the daemon's restarts as the
// contexts those requests named, so a click after one, before the session's
// next request, still finds its config and pane.
//
// [LAW:behavior-not-structure] Each case notes requests and reads the book
// back, over a store file held in memory as the disk would hold it.

import { SessionRequests } from "../../src/daemon/session-requests";
import { checkRenderRequest } from "../../src/daemon/render-checkpoint";
import { PROTOCOL_VERSION } from "../../src/daemon/foundations/protocol";
import {
  sessionIdOf,
  type SessionId,
} from "../../src/daemon/foundations/session-id";
import {
  contextOf,
  type CheckedRenderRequest,
} from "../../src/renderer-interface/request-context";
import type { StoreFile } from "../../src/daemon/store-file";
import { viewFacts } from "../helpers/view-facts";

const S1 = sessionIdOf("s1");
const S2 = sessionIdOf("s2");

// A disk the book's file is written to: its text, and how many writes it took.
function disk(text: string | null = null) {
  return { text, writes: 0 };
}

// A book over `on`, as a daemon builds one: nothing read until `load`.
function book(on = disk(), kept: (s: SessionId) => boolean = () => false) {
  const logged: string[] = [];
  const requests = new SessionRequests(
    (body): StoreFile => {
      let owed = false;
      return {
        read: () => ({ kind: "ok", value: on.text }),
        save: () => void (owed = true),
        flush: () => {
          if (!owed) return;
          owed = false;
          on.text = body();
          on.writes++;
        },
      };
    },
    (_level, line) => void logged.push(line),
    kept,
  );
  return { requests, logged, on };
}

// A statusline request of `session` from `cwd`, across the host's checkpoint.
function requestOf(
  session: string,
  cwd = "/nowhere/project",
  termCols?: number,
): CheckedRenderRequest {
  const checked = checkRenderRequest(
    {
      v: PROTOCOL_VERSION,
      kind: "render",
      hookData: viewFacts(cwd, session).hookData,
      args: ["cc-candybar"],
      cwd,
      encoding: "frame",
      ...(termCols === undefined ? {} : { termCols }),
    },
    { firstSightOfUnknownHookField: () => false },
    () => {},
    "/nowhere/home",
  );
  if (!checked.ok) throw new Error(checked.problems.join("; "));
  return checked.req;
}

test("a session's newest is the request received last, however late an earlier one's render finishes", () => {
  const { requests } = book();
  expect(requests.of(S1)).toBeNull();
  const two = requestOf("s1", "/nowhere/two");
  expect(requests.note(two, 2)).toBe(true);
  expect(requests.note(requestOf("s1", "/nowhere/one"), 1)).toBe(false);
  expect(requests.latest(S1)).toBe(two);
  expect(requests.of(S1)?.requested.cwd).toBe("/nowhere/two");
});

test("newestWhere finds the session of the newest request it matches", () => {
  const { requests } = book();
  requests.note(requestOf("s1", "/nowhere/a"), 1);
  requests.note(requestOf("s2", "/nowhere/a"), 2);
  expect(requests.newestWhere((r) => r.cwd === "/nowhere/a")).toBe(S2);
  expect(requests.newestWhere((r) => r.cwd === "/nowhere/z")).toBeNull();
});

test("the least recently noted session is dropped past the bound, unless it is kept", () => {
  const { requests } = book(disk(), (s) => s === S1);
  requests.note(requestOf("s1"), 0);
  for (let i = 1; i <= 300; i++) requests.note(requestOf(`other${i}`), i);
  expect(requests.of(S1)).not.toBeNull();
  expect(requests.of(sessionIdOf("other1"))).toBeNull();
  expect(requests.of(sessionIdOf("other300"))).not.toBeNull();
});

test("nothing is read until the daemon arms, and a restart reads back every context the close wrote", () => {
  const req = requestOf("s1", "/nowhere/project", 120);
  const first = book();
  first.requests.note(req, 1);
  first.requests.close();
  const next = book(first.on);
  expect(next.requests.of(S1)).toBeNull();
  next.requests.load();
  expect(contextOf(req).hints.termCols).toBe(120);
  expect(next.requests.of(S1)).toEqual(contextOf(req));
  // A context read back has no request of this daemon's life.
  expect(next.requests.latest(S1)).toBeNull();
});

test("after a restart, a request that names the context already held writes nothing, and one that moves it writes", () => {
  const first = book();
  first.requests.note(requestOf("s1"), 1);
  first.requests.close();
  const next = book(first.on);
  next.requests.load();
  next.requests.note(requestOf("s1"), 1);
  next.requests.close();
  expect(first.on.writes).toBe(1);
  const third = book(first.on);
  third.requests.load();
  third.requests.note(requestOf("s1", "/nowhere/moved"), 1);
  third.requests.close();
  expect(first.on.writes).toBe(2);
});

test("a session noted before the load keeps what it was noted with", () => {
  const first = book();
  first.requests.note(requestOf("s1", "/nowhere/old"), 1);
  first.requests.close();
  const next = book(first.on);
  next.requests.note(requestOf("s1", "/nowhere/new"), 1);
  next.requests.load();
  expect(next.requests.of(S1)?.requested.cwd).toBe("/nowhere/new");
});

test("a session id that names the object prototype is kept like any other", () => {
  const first = book();
  first.requests.note(requestOf("__proto__"), 1);
  first.requests.close();
  const next = book(first.on);
  next.requests.load();
  expect(next.requests.of(sessionIdOf("__proto__"))).not.toBeNull();
});

test("a file that is not JSON starts empty, and says so", () => {
  const { requests, logged } = book(disk("{ not valid json"));
  requests.load();
  expect(requests.of(S1)).toBeNull();
  expect(logged).toEqual([
    expect.stringMatching(
      /^session contexts: not JSON \(.*\); starting empty$/,
    ),
  ]);
});

test("an entry that does not read as a context is dropped, said, and the rest kept", () => {
  const req = requestOf("s2");
  const first = book();
  first.requests.note(req, 1);
  first.requests.close();
  const doc = JSON.parse(first.on.text!) as Record<string, unknown>;
  const { requests, logged } = book(
    disk(
      JSON.stringify({
        ...doc,
        s1: {
          requested: {
            projectDir: "relative",
            cwd: "/x",
            target: { source: "search" },
          },
          hints: {},
          transcript: "/t",
          answered: "yes",
        },
      }),
    ),
  );
  requests.load();
  expect(requests.of(S1)).toBeNull();
  expect(requests.of(S2)).toEqual(contextOf(req));
  expect(logged).toEqual([
    "session contexts: dropped session s1: not a context",
  ]);
});
