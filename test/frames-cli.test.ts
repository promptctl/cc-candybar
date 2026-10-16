// `cc-candybar frames` (src/frames-cli.ts): what a stream the daemon ended
// calls for, and a flag that could do nothing refused rather than ignored.

import { afterStreamEnd, runFrames } from "../src/frames-cli";

const refused = (code: "BAD_REQUEST" | "VERSION_MISMATCH" | "TIMEOUT") =>
  ({
    kind: "refused",
    resp: { ok: false, code, error: `${code} said` },
  }) as const;

test("a daemon that refuses the stream for good ends the client; a busy one, a restart and a failure reconnect", () => {
  expect(afterStreamEnd(refused("BAD_REQUEST"))).toEqual({
    kind: "exit",
    reason: "the daemon refused the stream: BAD_REQUEST: BAD_REQUEST said",
  });
  expect(afterStreamEnd(refused("VERSION_MISMATCH"))).toMatchObject({ kind: "exit" });
  expect(afterStreamEnd(refused("TIMEOUT"))).toMatchObject({
    kind: "reconnect",
    kick: false,
  });
  expect(afterStreamEnd({ kind: "closed-there" })).toMatchObject({
    kind: "reconnect",
    kick: false,
  });
  // No daemon answered: one is kicked into existence before the reconnect.
  expect(
    afterStreamEnd({ kind: "failed", error: new Error("ENOENT") }),
  ).toEqual({ kind: "reconnect", reason: "stream failed (ENOENT)", kick: true });
});

test("--config beside --session is refused with exit 2, since no data is forwarded to carry it", async () => {
  const exit = jest.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`);
  });
  const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await expect(
      runFrames(["node", "cc-candybar", "frames", "--session", "s", "--config", "/tmp/x.json5"]),
    ).rejects.toThrow("exit 2");
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/--config has no effect with --session/);
  } finally {
    exit.mockRestore();
    stderr.mockRestore();
  }
});
