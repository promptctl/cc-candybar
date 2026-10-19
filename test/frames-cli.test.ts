// `cc-candybar frames` (src/frames-cli.ts): what a stream the daemon ended
// calls for, and a flag that could do nothing refused rather than ignored.

import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import { runFrames } from "../src/frames-cli";
import { afterStreamEnd } from "../src/daemon/frame-follow";

const refused = (
  code: "BAD_REQUEST" | "VERSION_MISMATCH" | "TIMEOUT" | "SWITCHED_OFF",
  daemonV = PROTOCOL_VERSION,
) =>
  ({
    kind: "refused",
    resp: { ok: false, code, error: `${code} said`, daemonV },
  }) as const;

test("only a daemon newer than this client ends it; an older, busy, restarted or absent one is reconnected", () => {
  // This client's subscribe is well formed, so BAD_REQUEST is a daemon from
  // before subscribe, which restarts itself on the new build.
  expect(afterStreamEnd(refused("BAD_REQUEST"))).toEqual({
    kind: "reconnect",
    reason:
      "the daemon does not take subscribe (BAD_REQUEST said); it restarts on the new build",
    kick: false,
  });
  // A daemon newer than this client: this client is the stale one.
  expect(afterStreamEnd(refused("VERSION_MISMATCH", PROTOCOL_VERSION + 1))).toMatchObject({
    kind: "exit",
  });
  // A daemon older than this client exits on that answer, so a respawn runs
  // the newer build.
  expect(afterStreamEnd(refused("VERSION_MISMATCH", PROTOCOL_VERSION - 1))).toMatchObject({
    kind: "reconnect",
    kick: true,
  });
  expect(afterStreamEnd(refused("TIMEOUT"))).toMatchObject({
    kind: "reconnect",
    kick: false,
  });
  expect(afterStreamEnd({ kind: "closed-there" })).toMatchObject({
    kind: "reconnect",
    kick: false,
  });
  // The lane's toggle is off: the stream's state, not a fault, and asked
  // again, so turning it on resumes the stream.
  expect(afterStreamEnd(refused("SWITCHED_OFF"))).toEqual({
    kind: "off",
    resp: refused("SWITCHED_OFF").resp,
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
      runFrames(["node", "cc-candybar", "frames", "--lane", "band", "--session", "s", "--config", "/tmp/x.json5"], "/opt/cc/dist/index.mjs"),
    ).rejects.toThrow("exit 2");
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/--config has no effect with --session/);
  } finally {
    exit.mockRestore();
    stderr.mockRestore();
  }
});

test("an empty --session is refused with exit 2: the subscribe this client sends is well formed", async () => {
  const exit = jest.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`);
  });
  const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await expect(runFrames(["node", "cc-candybar", "frames", "--lane", "band", "--session", ""], "/opt/cc/dist/index.mjs")).rejects.toThrow(
      "exit 2",
    );
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/--session needs a session id/);
  } finally {
    exit.mockRestore();
    stderr.mockRestore();
  }
});

test("a missing or unknown --lane is refused with exit 2, naming the lanes", async () => {
  for (const argv of [
    ["node", "cc-candybar", "frames", "--session", "s"],
    ["node", "cc-candybar", "frames", "--lane", "everywhere", "--session", "s"],
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
