// [LAW:behavior-not-structure] A session id crosses one checkpoint at every
// door it comes in by — a render's hook JSON, a subscribe, a click — and each
// door refuses the same ids and passes the same ones. The checkpoint and the click
// verbs are here; the doors at a daemon are test/daemon-boots/worker/session-id-at-the-daemon.test.ts.

import { randomUUID } from "node:crypto";
import { parseSessionId, sessionIdOf } from "../src/daemon/session-id";
import { SessionState } from "../src/daemon/session-state";
import { BadVerbArgs, VERBS } from "../src/daemon/verbs";
import { encodeSegments } from "../src/click/wire";
import { testVerbContext } from "./helpers/click";
import { REFUSED } from "./helpers/session-id-refused";

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

  test.each(REFUSED)("refuses %s", async (_, raw, problem) => {
    const ctx = testVerbContext(new SessionState());
    await expect(toggle(encodeURIComponent(raw), ctx)).rejects.toThrow(BadVerbArgs);
    await expect(toggle(encodeURIComponent(raw), ctx)).rejects.toThrow(problem);
    await expect(stepState(encodeSegments([raw, "k", "1"]), ctx)).rejects.toThrow(
      problem,
    );
  });

  test("passes a UUID", async () => {
    const state = new SessionState();
    const uuid = sessionIdOf(randomUUID());
    await toggle(encodeURIComponent(uuid), testVerbContext(state));
    expect(state.get(uuid, "toolbar-expanded")).toBe("1");
  });
});
