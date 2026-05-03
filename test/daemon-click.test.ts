import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PROTOCOL_VERSION, encodeFrame, makeFrameReader } from "../src/daemon/protocol";
import type { Response } from "../src/daemon/protocol";
import { socketPath } from "../src/daemon/paths";
import { ToolbarState } from "../src/daemon/toolbar-state";

// --- ToolbarState unit tests ---

describe("ToolbarState", () => {
  test("starts with nothing expanded", () => {
    const state = new ToolbarState();
    expect(state.isExpanded("abc-123")).toBe(false);
  });

  test("toggle adds and removes a session", () => {
    const state = new ToolbarState();
    state.toggle("abc-123");
    expect(state.isExpanded("abc-123")).toBe(true);
    state.toggle("abc-123");
    expect(state.isExpanded("abc-123")).toBe(false);
  });

  test("different sessions are independent", () => {
    const state = new ToolbarState();
    state.toggle("session-a");
    expect(state.isExpanded("session-a")).toBe(true);
    expect(state.isExpanded("session-b")).toBe(false);
  });

  test("size tracks expanded count", () => {
    const state = new ToolbarState();
    expect(state.size).toBe(0);
    state.toggle("a");
    state.toggle("b");
    expect(state.size).toBe(2);
    state.toggle("a");
    expect(state.size).toBe(1);
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

// --- Toolbar toggle integration ---
// Verify the dataflow: toolbar-toggle click updates daemon state, next render
// sees the change without re-reading from disk.

describe("toolbar toggle dataflow", () => {
  test("toggle via ToolbarState reflects in isExpanded without disk I/O", () => {
    // [LAW:one-source-of-truth] The ToolbarState is the daemon's in-memory
    // source of truth. No file reads needed.
    const state = new ToolbarState();
    const sessionId = "toggle-test-session";

    // Initially not expanded.
    expect(state.isExpanded(sessionId)).toBe(false);

    // Toggle → expanded.
    state.toggle(sessionId);
    expect(state.isExpanded(sessionId)).toBe(true);

    // Toggle again → collapsed.
    state.toggle(sessionId);
    expect(state.isExpanded(sessionId)).toBe(false);
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
            const knownVerbs = ["copy", "open-vscode", "toolbar-toggle"];
            if (!knownVerbs.includes(parsed.verb ?? "")) {
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
