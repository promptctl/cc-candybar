// [LAW:behavior-not-structure] A session id crosses one checkpoint at every
// door it comes in by — a render's hook JSON, a subscribe, a click — and each
// door refuses the same ids and passes the same ones. The checkpoint and the click
// verbs are here; the doors at a daemon are test/daemon-boots/worker/session-id-at-the-daemon.test.ts.

import { randomUUID } from "node:crypto";
import { parseSessionId, sessionIdOf } from "../src/daemon/foundations/session-id";
import { SessionState } from "../src/renderer/session-state";
import { BadVerbArgs, VERBS } from "../src/renderer/verbs";
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
  const stepState = VERBS.get("step-state")!;
  const copyDiagnostic = VERBS.get("copy-diagnostic")!;

  test.each(REFUSED)("refuses %s", async (_, raw, problem) => {
    const ctx = testVerbContext(new SessionState());
    const step = stepState(encodeSegments([raw, "k", "1"]), ctx);
    await expect(step).rejects.toThrow(BadVerbArgs);
    await expect(stepState(encodeSegments([raw, "k", "1"]), ctx)).rejects.toThrow(
      problem,
    );
  });

  test("passes a UUID", async () => {
    const uuid = sessionIdOf(randomUUID());
    // Past the session-id checkpoint, the click fails on what it asks for:
    // this context's draws list no diagnostic.
    await expect(
      copyDiagnostic(
        encodeSegments([uuid, "request", "k"]),
        testVerbContext(new SessionState()),
      ),
    ).rejects.toThrow(`no longer listed in session ${uuid}'s diagnostics`);
  });
});
