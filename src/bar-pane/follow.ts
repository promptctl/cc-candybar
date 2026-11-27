// One physical pane connection across session and placement changes. Only a
// transport failure reconnects. A surface its owner retired exits.
import type { Timekeeper } from "../time.js";
import {
  openStream,
  isRefusal,
  type FrameStream,
} from "../daemon/client-frames.js";
import { nextRetryMs, RECONNECT_FIRST_MS } from "../daemon/frame-follow.js";
import {
  parseResponse,
  PROTOCOL_VERSION,
} from "../daemon/foundations/protocol.js";
import {
  parsePaneUpdate,
  type PaneHello,
} from "../daemon/pane-subscription.js";

export function followPane(
  path: string,
  hello: PaneHello,
  clock: Timekeeper,
  update: (value: ReturnType<typeof parsePaneUpdate>) => void,
  lost: (reason: string) => void,
  end: (reason: string) => void,
): FrameStream {
  let stream: FrameStream;
  let cancel: (() => void) | null = null;
  let retry = RECONNECT_FIRST_MS;
  const open = () => {
    stream = openStream(
      path,
      { kind: "pane-enroll", v: PROTOCOL_VERSION, ...hello },
      (raw) => {
        if (raw && typeof raw === "object" && "ok" in raw) {
          const response = parseResponse(raw);
          if (isRefusal(response)) return response;
        }
        const message = parsePaneUpdate(raw);
        retry = RECONNECT_FIRST_MS;
        update(message);
        return null;
      },
      (result) => {
        if (result.kind === "closed-here") return;
        if (result.kind === "refused" && result.resp.code !== "TIMEOUT") {
          end(result.resp.error);
          return;
        }
        lost(
          result.kind === "failed"
            ? result.error.message
            : "daemon disconnected",
        );
        cancel = clock.after("bar pane reconnect", retry, open);
        retry = nextRetryMs(retry, "fault");
      },
    );
  };
  open();
  return {
    close: () => {
      cancel?.();
      stream.close();
    },
  };
}
