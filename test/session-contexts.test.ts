// The host's book of each session's context as its newest request named it,
// which a click is handed: kept across the daemon's restarts, so a click after
// one, before the session's next request, still finds its config and pane.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionContexts } from "../src/daemon/session-contexts";
import { checkRenderRequest } from "../src/daemon/render-checkpoint";
import { PROTOCOL_VERSION } from "../src/daemon/foundations/protocol";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import {
  contextOf,
  type CheckedRenderRequest,
} from "../src/renderer-interface/request-context";
import { heldClock } from "./helpers/held-clock";
import { jestTmpDir } from "./helpers/jest-tmp";
import { viewFacts } from "./helpers/view-facts";

const S1 = sessionIdOf("s1");
let dir: string;
let file: string;

beforeEach(() => {
  dir = jestTmpDir("state");
  mkdirSync(dir, { recursive: true });
  file = join(dir, "session-contexts.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function book() {
  const logged: string[] = [];
  const contexts = new SessionContexts(
    file,
    heldClock(new Date()),
    () => {},
    (_level, line) => logged.push(line),
  );
  return { contexts, logged };
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

test("a session's context is its newest request's, and one never seen has none", () => {
  const { contexts } = book();
  expect(contexts.of(S1)).toBeNull();
  contexts.note(requestOf("s1", "/nowhere/one"));
  contexts.note(requestOf("s1", "/nowhere/two"));
  expect(contexts.of(S1)?.requested.cwd).toBe("/nowhere/two");
});

test("a restart reads back every context the close wrote", () => {
  const req = requestOf("s1", "/nowhere/project", 120);
  const first = book().contexts;
  first.note(req);
  first.close();
  expect(contextOf(req).hints.termCols).toBe(120);
  expect(book().contexts.of(S1)).toEqual(contextOf(req));
});

test("after a restart, a request that names the context already held writes nothing", () => {
  const first = book().contexts;
  first.note(requestOf("s1"));
  first.close();
  const { contexts, logged } = book();
  contexts.note(requestOf("s1"));
  contexts.close();
  expect(logged.filter((l) => l.includes("saved"))).toEqual([]);
  contexts.note(requestOf("s1", "/nowhere/moved"));
  expect(contexts.of(S1)?.requested.cwd).toBe("/nowhere/moved");
});

test("a file that is not JSON starts empty, and says so", () => {
  writeFileSync(file, "{ not valid json");
  const { contexts, logged } = book();
  expect(contexts.of(S1)).toBeNull();
  expect(logged).toEqual([
    expect.stringMatching(
      /^session contexts: not JSON \(.*\); starting empty$/,
    ),
  ]);
});

test("an entry that does not read as a context is dropped, said, and the rest kept", () => {
  const req = requestOf("s2");
  const first = book().contexts;
  first.note(req);
  first.close();
  const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(
    file,
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
  );
  const { contexts, logged } = book();
  expect(contexts.of(S1)).toBeNull();
  expect(contexts.of(sessionIdOf("s2"))).toEqual(contextOf(req));
  expect(logged).toEqual([
    "session contexts: dropped session s1: not a context",
  ]);
});
