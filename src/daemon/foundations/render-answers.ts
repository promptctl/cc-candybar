// [LAW:single-enforcer] The replies a request that failed is answered with,
// whichever side drew it.

import {
  PROTOCOL_VERSION,
  type RenderEncoding,
  type Response,
} from "./protocol";
import { composeBar, type Frame } from "../../render/frame.js";
import type { Refusal } from "./protocol.js";
import { failureOf, type Failure } from "./verb-error.js";

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

// [LAW:single-enforcer] A render's failure is the daemon's, whatever kind was
// thrown: the request passed its checkpoint, and its reply is RENDER_FAILED.
export const renderFailure = (failure: Failure): Failure => ({
  ...failure,
  kind: "threw",
});

// [LAW:dataflow-not-control-flow] A render's answer in each encoding, looked up
// by the value the checkpoint parsed. Keyed by the type, so a new encoding names
// its answer here or fails to compile.
export const RENDER_ANSWERS: Readonly<
  Record<RenderEncoding, (frame: Frame) => Response>
> = {
  ansi: (frame) => ({ ok: true, output: composeBar(frame) }),
  frame: (frame) => ({ ok: true, frame }),
};
