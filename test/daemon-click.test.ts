import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PROTOCOL_VERSION, encodeFrame, makeFrameReader } from "../src/daemon/protocol";
import type { Response } from "../src/daemon/protocol";
import { socketPath } from "../src/daemon/paths";
import { SessionState } from "../src/daemon/session-state";
import { VERB_NAMES } from "../src/daemon/verbs";

// --- SessionState unit tests ---

describe("SessionState", () => {
  test("get returns null for unknown session/key", () => {
    const state = new SessionState();
    expect(state.get("abc-123", "theme")).toBeNull();
  });

  test("set/get round-trips a value", () => {
    const state = new SessionState();
    state.set("abc-123", "theme", "ocean");
    expect(state.get("abc-123", "theme")).toBe("ocean");
  });

  test("different sessions are independent", () => {
    const state = new SessionState();
    state.set("session-a", "theme", "ocean");
    state.set("session-b", "theme", "ember");
    expect(state.get("session-a", "theme")).toBe("ocean");
    expect(state.get("session-b", "theme")).toBe("ember");
  });

  test("clear removes a key", () => {
    const state = new SessionState();
    state.set("abc-123", "theme", "ocean");
    state.clear("abc-123", "theme");
    expect(state.get("abc-123", "theme")).toBeNull();
  });

  test("multiple keys per session are independent", () => {
    const state = new SessionState();
    state.set("abc-123", "theme", "ocean");
    state.set("abc-123", "style", "surface");
    expect(state.get("abc-123", "theme")).toBe("ocean");
    expect(state.get("abc-123", "style")).toBe("surface");
  });

  test("prune removes sessions not in the active set", () => {
    const state = new SessionState();
    state.set("a", "theme", "ocean");
    state.set("b", "theme", "ember");
    state.set("c", "theme", "forest");
    state.prune(new Set(["a", "c"]));
    expect(state.get("a", "theme")).toBe("ocean");
    expect(state.get("b", "theme")).toBeNull();
    expect(state.get("c", "theme")).toBe("forest");
  });

  test("toolbar-expanded key works for toggle semantics", () => {
    const state = new SessionState();
    expect(state.get("s1", "toolbar-expanded")).toBeNull();
    state.set("s1", "toolbar-expanded", "1");
    expect(state.get("s1", "toolbar-expanded")).toBe("1");
    state.clear("s1", "toolbar-expanded");
    expect(state.get("s1", "toolbar-expanded")).toBeNull();
  });
});

// --- Protocol-level click tests ---
// These test the daemon handles click requests over the wire. We spin up a
// minimal daemon echo server that mimics the daemon's click dispatch.

describe("click protocol", () => {
  test("ClickRequest serializes with correct kind", () => {
    const req = {
      v: PROTOCOL_VERSION,
      kind: "click" as const,
      verb: "toolbar-toggle",
      value: "test-session",
    };
    const encoded = encodeFrame(req);
    const len = encoded.readUInt32BE(0);
    const body = JSON.parse(encoded.subarray(4, 4 + len).toString("utf8"));
    expect(body.kind).toBe("click");
    expect(body.verb).toBe("toolbar-toggle");
    expect(body.value).toBe("test-session");
  });

  test("unknown click verb returns BAD_REQUEST", async () => {
    const resp = await sendToTestServer({
      v: PROTOCOL_VERSION,
      kind: "click",
      verb: "nonexistent-verb",
      value: "test",
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("BAD_REQUEST");
      expect(resp.error).toContain("unknown click verb");
    }
  });
});

// --- Test that statusline binary has no in-process render path ---

describe("statusline binary render isolation", () => {
  test("index.ts does not import PowerlineRenderer", () => {
    const indexSrc = fs.readFileSync(
      path.join(__dirname, "../src/index.ts"),
      "utf8",
    );
    expect(indexSrc).not.toContain("PowerlineRenderer");
    expect(indexSrc).not.toContain("GitService");
    expect(indexSrc).not.toContain("loadConfigFromCLI");
  });

  test("index.ts has no inline render path", () => {
    const indexSrc = fs.readFileSync(
      path.join(__dirname, "../src/index.ts"),
      "utf8",
    );
    // The only render attempt is via tryRenderViaDaemon.
    expect(indexSrc).toContain("tryRenderViaDaemon");
    // No fallback to in-process rendering.
    expect(indexSrc).not.toContain("generateStatusline");
    expect(indexSrc).not.toContain("new PowerlineRenderer");
  });
});

// --- Toolbar toggle dataflow ---
// Verify the dataflow: toolbar-toggle click updates daemon state, next render
// sees the change without re-reading from disk.

describe("toolbar toggle dataflow", () => {
  test("toggle via SessionState reflects in get without disk I/O", () => {
    // [LAW:one-source-of-truth] The SessionState is the daemon's in-memory
    // source of truth. No file reads needed.
    const state = new SessionState();
    const sessionId = "toggle-test-session";

    // Initially not expanded.
    expect(state.get(sessionId, "toolbar-expanded")).toBeNull();

    // Set → expanded.
    state.set(sessionId, "toolbar-expanded", "1");
    expect(state.get(sessionId, "toolbar-expanded")).toBe("1");

    // Clear → collapsed.
    state.clear(sessionId, "toolbar-expanded");
    expect(state.get(sessionId, "toolbar-expanded")).toBeNull();
  });
});

// --- Helper: minimal daemon-like server for protocol tests ---

function sendToTestServer(req: unknown): Promise<Response> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      const reader = makeFrameReader(
        (frame) => {
          const parsed = frame as { kind: string; verb?: string; v: number };
          // Mimic daemon's click dispatch logic for test purposes.
          if (parsed.kind === "click") {
            // [LAW:one-source-of-truth] Use the registry directly so the test
            // and the daemon cannot disagree about which verbs are valid.
            if (!VERB_NAMES.includes(parsed.verb ?? "")) {
              sock.write(
                encodeFrame({
                  ok: false,
                  error: `unknown click verb: ${parsed.verb}`,
                  code: "BAD_REQUEST",
                }),
              );
            } else {
              sock.write(encodeFrame({ ok: true, output: "" }));
            }
          } else {
            sock.write(encodeFrame({ ok: true, output: "" }));
          }
          sock.end();
          server.close();
        },
        (err) => reject(err),
      );
      sock.on("data", reader);
    });

    const testSocket = path.join(os.tmpdir(), `cpwl-test-${Date.now()}.sock`);
    server.listen(testSocket, () => {
      const client = net.createConnection({ path: testSocket }, () => {
        client.write(encodeFrame(req));
      });
      const respReader = makeFrameReader(
        (frame) => {
          resolve(frame as Response);
          client.end();
        },
        (err) => reject(err),
      );
      client.on("data", respReader);
      client.on("error", reject);
    });
  });
}
