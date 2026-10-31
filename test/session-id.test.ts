// [LAW:behavior-not-structure] A session id crosses one checkpoint at every
// door it comes in by — a render's hook JSON, a subscribe, a click — and each
// door refuses the same ids and passes the same ones.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import {
  parseSessionId,
  SESSION_ID_MAX_BYTES,
} from "../src/daemon/session-id";
import { SessionState } from "../src/daemon/session-state";
import { BadVerbArgs, VERBS } from "../src/daemon/verbs";
import { encodeSegments } from "../src/click/wire";
import { testVerbContext } from "./helpers/click";
import { hookData, renderRequest } from "./helpers/daemon-e2e";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import { startDaemon, type InWorkerDaemon } from "./helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "./helpers/spawn-isolated-daemon";

// Every id a door refuses, and the problem the checkpoint names.
const REFUSED: ReadonlyArray<readonly [string, string, RegExp]> = [
  ["empty", "", /is empty/],
  ["a slash", "a/b", /path separator/],
  ["a backslash", "a\\b", /path separator/],
  ["NUL", "a\0b", /NUL/],
  ["dot", ".", /names a folder/],
  ["dot-dot", "..", /names a folder/],
  ["too long", "x".repeat(SESSION_ID_MAX_BYTES + 1), /longer than 250 bytes/],
];

describe("the session-id checkpoint", () => {
  test.each(REFUSED)("refuses %s", (_, raw, problem) => {
    const parsed = parseSessionId(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toMatch(problem);
  });

  test("refuses a value that is not a string", () => {
    expect(parseSessionId(42)).toMatchObject({ ok: false });
    expect(parseSessionId(undefined)).toMatchObject({ ok: false });
  });

  test("passes a UUID, and an id of exactly the byte limit", () => {
    const uuid = randomUUID();
    expect(parseSessionId(uuid)).toEqual({ ok: true, id: uuid });
    // Bytes, not characters: 125 two-byte characters are 250 bytes.
    expect(parseSessionId("é".repeat(125)).ok).toBe(true);
    expect(parseSessionId("é".repeat(126)).ok).toBe(false);
  });
});

describe("a click's session id", () => {
  const toggle = VERBS.get("toolbar-toggle")!;
  const stepState = VERBS.get("step-state")!;

  test.each(REFUSED)("refuses %s", (_, raw, problem) => {
    const ctx = testVerbContext(new SessionState());
    expect(() => toggle(encodeURIComponent(raw), ctx)).toThrow(BadVerbArgs);
    expect(() => toggle(encodeURIComponent(raw), ctx)).toThrow(problem);
    expect(() => stepState(encodeSegments([raw, "k", "1"]), ctx)).toThrow(
      problem,
    );
  });

  test("passes a UUID", () => {
    const state = new SessionState();
    const uuid = randomUUID();
    toggle(encodeURIComponent(uuid), testVerbContext(state));
    expect(state.get(uuid, "toolbar-expanded")).toBe("1");
  });
});

describe("a render's and a subscribe's session id, at the daemon", () => {
  let daemon: InWorkerDaemon;
  let removeTmpDirs: () => void;
  let projectDir: string;
  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-session-id");
    ({ removeTmpDirs } = prepared);
    daemon = startDaemon(prepared.env);
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-session-id-"));
  });
  afterAll(async () => {
    await daemon.stop();
    removeTmpDirs();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const render = (sessionId: string) =>
    renderRequest(daemon, {
      hookData: hookData(sessionId, projectDir),
      args: [],
      cwd: projectDir,
    });
  const subscribe = (sessionId: string, lane: string) =>
    sendDaemonRequest(
      daemon,
      { v: PROTOCOL_VERSION, kind: "subscribe", sessionId, lane },
      5000,
    );

  test.each(REFUSED)("a render refuses %s", async (_, raw, problem) => {
    await expect(render(raw)).rejects.toThrow(/BAD_REQUEST/);
    await expect(render(raw)).rejects.toThrow(problem);
  });

  test.each(REFUSED)("a subscribe refuses %s", async (_, raw, problem) => {
    expect(await subscribe(raw, "band")).toMatchObject({
      ok: false,
      code: "BAD_REQUEST",
      error: expect.stringMatching(problem),
    });
  });

  test("a UUID passes both", async () => {
    const uuid = randomUUID();
    expect(typeof (await render(uuid))).toBe("string");
    // Past the id, the subscribe is refused for its lane, not its session.
    expect(await subscribe(uuid, "everywhere")).toMatchObject({
      ok: false,
      code: "BAD_REQUEST",
      error: expect.stringMatching(/needs a lane/),
    });
  });
});
