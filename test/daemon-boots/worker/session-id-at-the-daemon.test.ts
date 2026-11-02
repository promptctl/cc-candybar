// [LAW:behavior-not-structure] A render's and a subscribe's session id cross the
// same checkpoint as a click's, at the daemon that serves them: each door refuses
// the ids the checkpoint refuses (test/session-id.test.ts) and passes a UUID.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION } from "../../../src/daemon/protocol";
import { hookData, renderRequest } from "../../helpers/daemon-e2e";
import { sendDaemonRequest } from "../../helpers/daemon-wire";
import { startDaemon, type InWorkerDaemon } from "../../helpers/in-worker-daemon";
import { REFUSED } from "../../helpers/session-id-refused";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";

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
