// [LAW:verifiable-goals] Where a stream of frames ends: a frame whose handler
// asks for no more, the handler's own throw, or a malformed frame. Whichever it
// is, nothing after is handled, and a handler's throw reaches the error arm as
// itself, never as the peer's malformed frame.

import { duplexPair } from "node:stream";

import {
  FRAME_HEADER_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  encodeFrame,
  makeFrameReader,
  sendOne,
} from "../../src/daemon/foundations/protocol";
import { interpretException } from "../../src/daemon/client-transport";

const reading = (next: (frame: unknown) => "more" | "done") => {
  const frames: unknown[] = [];
  const errors: Error[] = [];
  const feed = makeFrameReader(
    (frame) => {
      frames.push(frame);
      return next(frame);
    },
    (err) => errors.push(err),
  );
  return { feed, frames, errors };
};

const TWO = Buffer.concat([encodeFrame(1), encodeFrame(2)]);

test("a reader that asks for more reads every frame", () => {
  const r = reading(() => "more");
  r.feed(TWO);
  expect({ frames: r.frames, errors: r.errors }).toEqual({
    frames: [1, 2],
    errors: [],
  });
});

test("a reader that is done reads nothing after, in its chunk or later", () => {
  const r = reading(() => "done");
  r.feed(TWO);
  r.feed(encodeFrame(3));
  expect({ frames: r.frames, errors: r.errors }).toEqual({
    frames: [1],
    errors: [],
  });
});

test("a handler's throw ends the stream and reaches the error arm as itself", () => {
  const thrown = new Error("cannot take it");
  const r = reading(() => {
    throw thrown;
  });
  r.feed(TWO);
  r.feed(encodeFrame(3));
  expect(r.frames).toEqual([1]);
  expect(r.errors).toEqual([thrown]);
  expect(r.errors[0]).not.toBeInstanceOf(ProtocolError);
});

test("a frame stated past the cap is one ProtocolError, and what follows is never read", () => {
  const r = reading(() => "more");
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(0xffffffff);
  r.feed(header);
  r.feed(encodeFrame(1));
  expect(r.frames).toEqual([]);
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0]).toBeInstanceOf(ProtocolError);
});

// [LAW:parse-dont-validate] A one-frame request takes only a response: a
// frame that is none is malformed, the permanent class the native client
// gives it, never a connection failure that would kick a live daemon.
test.each([null, [], {}])(
  "a request answered with a frame that is no response (%j) is malformed",
  async (frame) => {
    const [client, daemon] = duplexPair();
    daemon.once("data", () => daemon.write(encodeFrame(frame)));
    const error: unknown = await sendOne(
      client,
      { v: PROTOCOL_VERSION, kind: "stats" },
      Infinity,
      { now: () => 0, after: () => () => {} },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProtocolError);
    expect(interpretException(error)).toMatchObject({
      kind: "permanent",
      cause: "malformed_response",
    });
  },
);
