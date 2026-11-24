// A frame stream ends once, and an ended stream hands its consumer nothing
// more, whatever the daemon wrote after the frame that ended it.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { openFrameStream, type StreamEnd } from "../src/daemon/client-frames";
import {
  encodeFrame,
  PROTOCOL_VERSION,
  ProtocolError,
} from "../src/daemon/foundations/protocol";

const FRAME = { ok: true, bar: "x", daemonV: PROTOCOL_VERSION };

// A daemon stand-in that writes `chunk` to its subscriber in one write.
async function streamOf(chunk: Buffer): Promise<{
  frames: unknown[];
  ends: StreamEnd[];
  consume: (take: (frame: unknown) => void) => Promise<void>;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frames-"));
  const sockPath = path.join(dir, "d.sock");
  const server = net.createServer((sock) => {
    sock.once("data", () => sock.write(chunk));
  });
  await new Promise<void>((ready) => server.listen(sockPath, ready));
  const frames: unknown[] = [];
  const ends: StreamEnd[] = [];
  const consume = (take: (frame: unknown) => void): Promise<void> =>
    new Promise((done) => {
      openFrameStream(
        sockPath,
        "s",
        "pane",
        (frame) => {
          frames.push(frame);
          take(frame);
        },
        (end) => {
          ends.push(end);
          server.close();
          fs.rmSync(dir, { recursive: true, force: true });
          setImmediate(done);
        },
      );
    });
  return { frames, ends, consume };
}

test("a consumer that throws on a frame is handed none of the frames after it", async () => {
  const stream = await streamOf(
    Buffer.concat([encodeFrame(FRAME), encodeFrame(FRAME)]),
  );
  await stream.consume(() => {
    throw new Error("cannot take it");
  });
  expect({
    frames: stream.frames.length,
    ends: stream.ends.map((e) => e.kind),
  }).toEqual({ frames: 1, ends: ["failed"] });
});

test.each([null, [], {}])(
  "a frame that is no response (%j) fails the stream as malformed and reaches no consumer",
  async (frame) => {
    const stream = await streamOf(encodeFrame(frame));
    await stream.consume(() => {});
    expect({
      frames: stream.frames.length,
      ends: stream.ends.map((e) =>
        e.kind === "failed"
          ? {
              malformed: e.error instanceof ProtocolError,
              why: e.error.message,
            }
          : e.kind,
      ),
    }).toEqual({
      frames: 0,
      ends: [
        {
          malformed: true,
          why: `a frame that is not a response: ${JSON.stringify(frame)}`,
        },
      ],
    });
  },
);
