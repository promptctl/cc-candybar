// `cc-candybar frames` (src/frames-cli.ts): what a stream the daemon ended
// says, and a lane it cannot serve refused rather than ignored. Which end
// calls for what, what is said, and the backoff are the shared cases
// (test/frame-follow-cases.test.ts).

import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import { runFrames } from "../src/frames-cli";
import { afterStreamEnd } from "../src/daemon/frame-follow";

test("a reconnect says why: a daemon from before subscribe restarts on the new build, an absent one is named", () => {
  expect(
    afterStreamEnd({
      kind: "refused",
      resp: { ok: false, code: "BAD_REQUEST", error: "BAD_REQUEST said", daemonV: PROTOCOL_VERSION },
    }),
  ).toEqual({
    kind: "reconnect",
    reason:
      "the daemon does not take subscribe (BAD_REQUEST said); it restarts on the new build",
    kick: false,
  });
  expect(
    afterStreamEnd({ kind: "failed", error: new Error("ENOENT") }),
  ).toEqual({ kind: "reconnect", reason: "stream failed (ENOENT)", kick: true });
});

test("a missing or unknown --lane is refused with exit 2, naming the lanes", async () => {
  for (const argv of [
    ["node", "cc-candybar", "frames"],
    ["node", "cc-candybar", "frames", "--lane", "everywhere"],
  ]) {
    const exit = jest.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(runFrames(argv, "/opt/cc/dist/index.mjs")).rejects.toThrow("exit 2");
      expect(String(stderr.mock.calls[0]?.[0])).toMatch(
        /--lane needs one of band, statusline, pane/,
      );
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  }
});

test("--session is not a flag of frames: a named session's frames are the native client's follow", async () => {
  await expect(
    runFrames(["node", "cc-candybar", "frames", "--lane", "band", "--session", "s"], "/opt/cc/dist/index.mjs"),
  ).rejects.toThrow(/--session/);
});
