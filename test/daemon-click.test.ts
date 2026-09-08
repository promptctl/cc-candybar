import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PROTOCOL_VERSION, encodeFrame, makeFrameReader } from "../src/daemon/protocol";
import type { Response } from "../src/daemon/protocol";
import { socketPath } from "../src/daemon/paths";
import { SessionState } from "../src/daemon/session-state";
import { VERBS, VERB_NAMES, BadVerbArgs } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import { registerStateValidator } from "../src/daemon/verbs/state-validators";
import { encodeSegments, VERB_STEP_STATE, VERB_APPLY_UPDATE } from "../src/click/wire";
import { testVerbContext } from "./helpers/click";

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

  test("VERBS lookup is prototype-pollution-safe", () => {
    // [LAW:types-are-the-program][LAW:behavior-not-structure] A ReadonlyMap makes
    // `__proto__` a non-member; the lookup guarantee is pinned, not the type.
    for (const poison of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(VERBS.get(poison)).toBeUndefined();
    }
  });

  test("malformed wire encoding is a BadVerbArgs (→ BAD_REQUEST), not an operational failure", () => {
    // [LAW:behavior-not-structure] A raw URIError must be reclassified as
    // BadVerbArgs, or a bad escape surfaces as an operational RENDER_FAILED.
    const ctx: VerbContext = testVerbContext(new SessionState());
    for (const verb of ["copy", "set-state"]) {
      const handler = VERBS.get(verb)!;
      expect(() => handler("%", ctx)).toThrow(BadVerbArgs);
    }
  });
});

describe("apply-update verb", () => {
  test("a session id reaches ctx.applyUpdate once; a missing or unsafe one is BadVerbArgs and never does", () => {
    let calls = 0;
    const ctx: VerbContext = {
      ...testVerbContext(new SessionState()),
      applyUpdate: () => {
        calls++;
      },
    };
    const handler = VERBS.get(VERB_APPLY_UPDATE)!;
    handler(encodeURIComponent("sess-1"), ctx);
    expect(calls).toBe(1);
    expect(() => handler("", ctx)).toThrow(BadVerbArgs);
    expect(() => handler(encodeURIComponent("../etc"), ctx)).toThrow(BadVerbArgs);
    expect(calls).toBe(1);
  });
});

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
    expect(indexSrc).toContain("tryRenderViaDaemon");
    expect(indexSrc).not.toContain("generateStatusline");
    expect(indexSrc).not.toContain("new PowerlineRenderer");
  });
});

describe("toolbar toggle dataflow", () => {
  test("toggle via SessionState reflects in get without disk I/O", () => {
    // [LAW:one-source-of-truth] SessionState is the daemon's in-memory truth.
    const state = new SessionState();
    const sessionId = "toggle-test-session";

    expect(state.get(sessionId, "toolbar-expanded")).toBeNull();

    state.set(sessionId, "toolbar-expanded", "1");
    expect(state.get(sessionId, "toolbar-expanded")).toBe("1");

    state.clear(sessionId, "toolbar-expanded");
    expect(state.get(sessionId, "toolbar-expanded")).toBeNull();
  });
});

// [LAW:behavior-not-structure] The handler reads LIVE state per click, so the
// value moves once per CLICK regardless of render cadence.

describe("step-state handler", () => {
  const KEY = "step-test-hue";
  function setup() {
    const sessionState = new SessionState();
    const ctx: VerbContext = testVerbContext(sessionState);
    const dispose = registerStateValidator(KEY, {
      kind: "range",
      min: 0,
      max: 60,
      seed: 14,
    });
    const step = VERBS.get(VERB_STEP_STATE)!;
    const click = (by: number): void =>
      step(encodeSegments(["s1", KEY, String(by)]), ctx);
    return { sessionState, click, dispose };
  }

  test("an unset key seeds from the registry default, not min", () => {
    const { sessionState, click, dispose } = setup();
    expect(sessionState.get("s1", KEY)).toBeNull();
    click(2);
    expect(sessionState.get("s1", KEY)).toBe("16");
    dispose();
  });

  test("N identical clicks accumulate N steps (idempotency gone)", () => {
    const { sessionState, click, dispose } = setup();
    click(2);
    click(2);
    click(2);
    expect(sessionState.get("s1", KEY)).toBe("20");
    dispose();
  });

  test("stepping past a bound WRAPS to the other end", () => {
    const { sessionState, click, dispose } = setup();
    sessionState.set("s1", KEY, "60");
    click(2);
    expect(sessionState.get("s1", KEY)).toBe("0");
    dispose();
  });

  test("a negative delta steps down", () => {
    const { sessionState, click, dispose } = setup();
    sessionState.set("s1", KEY, "10");
    click(-2);
    expect(sessionState.get("s1", KEY)).toBe("8");
    dispose();
  });

  test("a non-integer delta is BadVerbArgs (→ BAD_REQUEST)", () => {
    const { dispose } = setup();
    const step = VERBS.get(VERB_STEP_STATE)!;
    const ctx: VerbContext = testVerbContext(new SessionState());
    expect(() =>
      step(encodeSegments(["s1", KEY, "x"]), ctx),
    ).toThrow(BadVerbArgs);
    dispose();
  });

  test("a key with no range registration is rejected, not silently stepped", () => {
    const step = VERBS.get(VERB_STEP_STATE)!;
    const ctx: VerbContext = testVerbContext(new SessionState());
    expect(() =>
      step(encodeSegments(["s1", "not-a-stepper", "2"]), ctx),
    ).toThrow(BadVerbArgs);
  });

  test("step-state is a registered leaf verb", () => {
    expect(VERB_NAMES).toContain(VERB_STEP_STATE);
  });
});

function sendToTestServer(req: unknown): Promise<Response> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      const reader = makeFrameReader(
        (frame) => {
          const parsed = frame as { kind: string; verb?: string; v: number };
          if (parsed.kind === "click") {
            // [LAW:one-source-of-truth] The registry, so the test cannot drift.
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
