// A session's frame stream, read from the daemon (the subscribe request,
// src/daemon/frame-feed.ts): every frame the daemon pushes, until the stream
// ends. One stream is one connection; keeping a stream up across daemon
// restarts is the caller's (src/frames-cli.ts).

import net from "node:net";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  makeFrameReader,
  parseResponse,
  type OwnerFacts,
  type Response,
  type PaneEnrollment,
  type SubscribeRequest,
} from "./foundations/protocol";
import type { Lane } from "../config/lanes";

// [LAW:types-are-the-program] Why a stream ended: the caller closed it, the
// daemon closed it (a restart, a shutdown), the daemon answered the subscribe
// with a refusal instead of frames (`resp`: too busy, a request it does not
// accept, another protocol version, the lane switched off — which also ends a
// stream already running), or the connection failed (no daemon listening, a
// frame that would not parse).
export type StreamEnd =
  | { readonly kind: "closed-here" }
  | { readonly kind: "closed-there" }
  | { readonly kind: "refused"; readonly resp: Refusal }
  | { readonly kind: "failed"; readonly error: Error };

type Refusal = Extract<Response, { ok: false }>;

export interface FrameStream {
  close(): void;
}

// [LAW:parse-dont-validate] Whether a message on a stream is its end: a frame
// that could not be drawn says so with RENDER_FAILED, and is a frame; every
// other failure code is the daemon refusing the subscribe itself, which ends
// the stream. The native follower decides by the same cases
// (test/fixtures/frame-follow-cases.json, `message`).
export function isRefusal(resp: Response): resp is Refusal {
  return !resp.ok && resp.code !== "RENDER_FAILED";
}

// Each pushed frame is the message the daemon sent for the lane — the bar, or
// why it could not be drawn — handed to `onFrame` as the daemon sent it, and a
// refusal ends the stream rather than reaching it. `onEnd` is called once.
export function openFrameStream(
  sockPath: string,
  sessionId: string,
  lane: Lane,
  onFrame: (resp: Response) => void,
  onEnd: (end: StreamEnd) => void,
  // A drawing surface can claim its current pointer. A height-blocked
  // window receives frames solely to learn when the inset fits again.
  interest?: OwnerFacts | "measure-window",
): FrameStream {
  if (interest === "measure-window" && lane !== "window")
    throw new Error("Only the window lane can measure an inset");
  const subscribe: SubscribeRequest =
    interest === "measure-window"
      ? {
          v: PROTOCOL_VERSION,
          kind: "measure-window",
          sessionId,
          lane: "window",
        }
      : {
          v: PROTOCOL_VERSION,
          kind: "subscribe",
          sessionId,
          lane,
          ...(interest !== undefined && { owner: interest }),
        };
  return openStream(
    sockPath,
    subscribe,
    (raw) => {
      const resp = parseResponse(raw);
      if (isRefusal(resp)) return resp;
      onFrame(resp);
      return null;
    },
    onEnd,
  );
}

export function openStream(
  sockPath: string,
  subscribe: SubscribeRequest | PaneEnrollment,
  read: (raw: unknown) => Refusal | null,
  onEnd: (end: StreamEnd) => void,
): FrameStream {
  let end: StreamEnd | null = null;
  const finish = (why: StreamEnd): void => {
    if (end !== null) return;
    end = why;
    sock.destroy();
    onEnd(why);
  };
  const sock = net.createConnection({ path: sockPath });
  sock.once("connect", () => sock.write(encodeFrame(subscribe)));
  sock.on(
    "data",
    makeFrameReader(
      (frame) => {
        // [LAW:parse-dont-validate] A frame that is no response throws its
        // ProtocolError into the failure below, as a malformed frame does.
        const refusal = read(frame);
        if (refusal) finish({ kind: "refused", resp: refusal });
        // [LAW:single-enforcer] An ended stream reads no more, so nothing
        // reaches `onFrame` after `onEnd`.
        return end === null ? "more" : "done";
      },
      (error) => finish({ kind: "failed", error }),
    ),
  );
  sock.on("error", (error) => finish({ kind: "failed", error }));
  sock.on("close", () => finish({ kind: "closed-there" }));
  return { close: () => finish({ kind: "closed-here" }) };
}
