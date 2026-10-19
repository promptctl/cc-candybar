// A session's frame stream, read from the daemon (the subscribe request,
// src/daemon/frame-feed.ts): every frame the daemon pushes, until the stream
// ends. One stream is one connection; keeping a stream up across daemon
// restarts is the caller's (src/frames-cli.ts).

import net from "node:net";
import { PROTOCOL_VERSION, encodeFrame, makeFrameReader } from "./protocol";
import type { Response, SubscribeRequest } from "./protocol";

// [LAW:types-are-the-program] Why a stream ended: the caller closed it, the
// daemon closed it (a restart, a shutdown), the daemon answered the subscribe
// with a refusal instead of frames (`resp`: too busy, a request it does not
// accept, another protocol version), or the connection failed (no daemon
// listening, a frame that would not parse).
export type StreamEnd =
  | { readonly kind: "closed-here" }
  | { readonly kind: "closed-there" }
  | { readonly kind: "refused"; readonly resp: Refusal }
  | { readonly kind: "failed"; readonly error: Error };

type Refusal = Extract<Response, { ok: false }>;

export interface FrameStream {
  close(): void;
}

// Each pushed frame is the response a render request is answered with — the
// bar, or why it could not be drawn — handed to `onFrame` as the daemon sent
// it. `onEnd` is called once.
// [LAW:parse-dont-validate] A frame that could not be drawn says so with
// RENDER_FAILED; every other failure code is the daemon refusing the subscribe
// itself, which ends the stream rather than reaching `onFrame`.
export function openFrameStream(
  sockPath: string,
  sessionId: string,
  onFrame: (resp: Response) => void,
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
  const subscribe: SubscribeRequest = {
    v: PROTOCOL_VERSION,
    kind: "subscribe",
    sessionId,
  };
  sock.once("connect", () => sock.write(encodeFrame(subscribe)));
  sock.on(
    "data",
    makeFrameReader(
      (frame) => {
        const resp = frame as Response;
        if (!resp.ok && resp.code !== "RENDER_FAILED")
          finish({ kind: "refused", resp });
        else onFrame(resp);
      },
      (error) => finish({ kind: "failed", error }),
    ),
  );
  sock.on("error", (error) => finish({ kind: "failed", error }));
  sock.on("close", () => finish({ kind: "closed-there" }));
  return { close: () => finish({ kind: "closed-here" }) };
}
