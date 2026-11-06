// [LAW:one-source-of-truth] The session a restart's Claude Code holds is read
// from the record Claude Code keeps of its process, on the disk, where the
// record lives.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { heldSessionIn, productionLaneEdge } from "../src/daemon/lane-edge";
import { processProbe } from "./helpers/host";
import { unscriptedLauncher } from "./helpers/fake-launcher";
import { systemTimekeeper } from "../src/time";

const SID = "3819990b-dd3f-4b32-ab79-c817debfc940";

describe("a Claude Code process's session record", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-session-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (file: string, text: string): string => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };

  test("names the session its process holds", () => {
    const file = write(path.join(dir, "4242.json"), JSON.stringify({ pid: 4242, sessionId: SID, status: "idle" }));
    expect(heldSessionIn(file)).toEqual({ kind: "holds", sessionId: SID });
  });

  test.each([
    ["missing", null, (file: string) => `it keeps no session record at ${file}`],
    ["not JSON", "{\"pid\": 42", (file: string) => expect.stringContaining(`its session record ${file} is not JSON (`)],
    ["without a session", JSON.stringify({ pid: 4242 }), (file: string) => `its session record ${file} names no session`],
    ["not an object", "42", (file: string) => `its session record ${file} names no session`],
  ])("%s, is said as unread, never as a session", (_case, text, why) => {
    const file = path.join(dir, "4242.json");
    if (text !== null) write(file, text);
    expect(heldSessionIn(file)).toEqual({ kind: "unread", why: why(file) });
  });

  // The client names Claude Code's configuration directory only when
  // CLAUDE_CONFIG_DIR set one; otherwise it is the user's ~/.claude.
  test("is read for the pid under the client's configuration directory, else under the user's home", () => {
    const edge = productionLaneEdge(unscriptedLauncher, () => new Set(), new AbortController().signal, systemTimekeeper, processProbe, dir);
    write(path.join(dir, ".claude", "sessions", "4242.json"), JSON.stringify({ sessionId: "default-dir" }));
    write(path.join(dir, "zai", "sessions", "4242.json"), JSON.stringify({ sessionId: "named-dir" }));
    expect(edge.heldSession(4242, undefined)).toEqual({ kind: "holds", sessionId: "default-dir" });
    expect(edge.heldSession(4242, path.join(dir, "zai"))).toEqual({ kind: "holds", sessionId: "named-dir" });
  });
});
