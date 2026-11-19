// [LAW:single-enforcer] The replies a request that failed is answered with,
// whichever side drew it.

import {
  PROTOCOL_VERSION,
  encodeJsonFrame,
  type RenderEncoding,
  type Response,
  type Refusal,
} from "./protocol";
import { composeBar, type Frame } from "../../render/frame.js";
import { failureOf, type Failure } from "./verb-error.js";

// A value as it crosses the wire: the value its frame carries, the frame, and
// why the value meant could not be sent, when it could not.
export interface Framed<T> {
  readonly sent: T;
  readonly frame: Buffer;
  readonly unsent: Error | null;
}

// [LAW:single-enforcer] The one fallback for a value no reader would take
// (one past the frame cap, or one that does not serialize): it is sent as the
// render failure naming why, drawn by the encoding the value would have had,
// which always fits. A reply is answered RENDER_FAILED, and a lane's pushed
// frame is the failure as that lane draws a render that failed.
export function framed<T>(
  value: T,
  encode: (value: T) => string,
  failure: (failed: Refusal) => T,
): Framed<T> {
  try {
    return { sent: value, frame: encodeJsonFrame(encode(value)), unsent: null };
  } catch (e) {
    const sent = failure(renderFailed(e));
    return {
      sent,
      frame: encodeJsonFrame(encode(sent)),
      unsent: e instanceof Error ? e : new Error(String(e)),
    };
  }
}

// A response, framed.
export const framedResponse = (resp: Response): Framed<Response> =>
  framed(resp, JSON.stringify, (failed) => failed);

// [LAW:single-enforcer] The one reply to a request that failed — a render's own
// throw, a turn's failure, or any other handler's throw that reached the
// connection — saying the failure's message.
export const failedWith = (message: string): Refusal => ({
  ok: false,
  error: message,
  code: "RENDER_FAILED",
  daemonV: PROTOCOL_VERSION,
});

export const renderFailed = (err: unknown): Refusal =>
  failedWith(failureOf(err).message);

// [LAW:single-enforcer] An argument failure inside a checked render is a
// daemon bug. Closing, abandonment and renderer availability retain their
// own outcomes even though the wire uses the same failure envelope.
export const renderFailure = (failure: Failure): Failure =>
  failure.kind === "bad-request" ? { ...failure, kind: "threw" } : failure;

// [LAW:dataflow-not-control-flow] A render's answer in each encoding, looked up
// by the value the checkpoint parsed. Keyed by the type, so a new encoding names
// its answer here or fails to compile.
export const RENDER_ANSWERS: Readonly<
  Record<RenderEncoding, (frame: Frame) => Response>
> = {
  ansi: (frame) => ({ ok: true, output: composeBar(frame) }),
  frame: (frame) => ({ ok: true, frame }),
};
