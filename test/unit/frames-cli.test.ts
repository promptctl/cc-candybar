// `cc-candybar frames` (src/frames-cli.ts): what a stream the daemon ended
// says, and a lane it cannot serve refused rather than ignored. Which end
// calls for what, what is said, and the backoff are the shared cases
// (test/frame-follow-cases.test.ts).

import { PROTOCOL_VERSION } from "../../src/daemon/foundations/protocol";
import { WORLD } from "../helpers/host";
import { parseStdinLine, runFrames } from "../../src/frames-cli";
import { REFUSED } from "../helpers/session-id-refused";
import { afterStreamEnd } from "../../src/daemon/frame-follow";

test("a reconnect says why: a daemon without subscribe support and a missing daemon are distinct", () => {
  expect(
    afterStreamEnd({
      kind: "refused",
      resp: {
        ok: false,
        code: "BAD_REQUEST",
        error: "BAD_REQUEST said",
        daemonV: PROTOCOL_VERSION,
      },
    }),
  ).toEqual({
    kind: "reconnect",
    reason:
      "the daemon does not take subscribe (BAD_REQUEST said)",
  });
  expect(
    afterStreamEnd({ kind: "failed", error: new Error("ENOENT") }),
  ).toEqual({
    kind: "reconnect",
    reason: "stream failed (ENOENT)",
  });
});

test("a missing or unknown --lane is refused with exit 2, naming the lanes", async () => {
  for (const argv of [
    ["node", "cc-candybar", "frames"],
    ["node", "cc-candybar", "frames", "--lane", "everywhere"],
  ]) {
    const exit = jest.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    const stderr = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await expect(
        runFrames(argv, "/opt/cc/dist/index.mjs", WORLD),
      ).rejects.toThrow("exit 2");
      expect(String(stderr.mock.calls[0]?.[0])).toMatch(
        /--lane needs one of statusline, pane/,
      );
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  }
});

test("--session is not a flag of frames: a named session's frames are the native client's follow", async () => {
  await expect(
    runFrames(
      ["node", "cc-candybar", "frames", "--lane", "statusline", "--session", "s"],
      "/opt/cc/dist/index.mjs",
      WORLD,
    ),
  ).rejects.toThrow(/--session/);
});

// [LAW:single-enforcer] A stdin line's session crosses the same checkpoint as
// the daemon's doors, so the stream never subscribes to a session the daemon
// would refuse.
describe("a stdin line's session_id", () => {
  test.each(REFUSED)("refuses %s", (_, raw, problem) => {
    const parsed = parseStdinLine(JSON.stringify({ session_id: raw }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problem).toMatch(/^stdin line's session_id /);
      expect(parsed.problem).toMatch(problem);
    }
  });

  test("refuses a line with none, and a line that is not JSON", () => {
    expect(parseStdinLine("{}")).toMatchObject({ ok: false });
    expect(parseStdinLine("null")).toMatchObject({ ok: false });
    expect(parseStdinLine("{")).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/^stdin line is not JSON/),
    });
  });

  test("passes a UUID, with the line it came on", () => {
    const hook = { session_id: "1f6e0c2a-0d0e-4a52-9d1b-2b0b0f0e0a11" };
    expect(parseStdinLine(JSON.stringify(hook))).toEqual({
      ok: true,
      session: hook.session_id,
      json: hook,
    });
  });
});
