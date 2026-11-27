// A session's frames, kept flowing for whoever draws them: the follower every
// consumer of the daemon's push runs (`cc-candybar frames`, the tmux bar pane).
// One stream is one connection (src/daemon/client-frames.ts); a follower opens
// the next when one ends, including across daemon restarts. It checks the
// lane again at a slower rate while the session has disabled it.

import type { World } from "../host";
import {
  openFrameStream,
  type FrameStream,
  type StreamEnd,
} from "./client-frames";
import {
  PROTOCOL_VERSION,
  type OwnerFacts,
  type Response,
} from "./foundations/protocol";
import type { Lane } from "../config/lanes";

export const RECONNECT_FIRST_MS = 250;
export const RECONNECT_MAX_MS = 2000;
// A lane switched off is a setting, not a fault, so it is asked again at a
// slower pace: a toggle left off costs the daemon one refusal per this.
export const SWITCHED_OFF_RETRY_MS = 5000;

type Refusal = Extract<Response, { ok: false }>;

// What moves the reconnect backoff: a frame drawn (the stream works, so the
// next failure starts over), a frame that could not be drawn (RENDER_FAILED:
// the stream works but says nothing about the next failure), a fault.
export type RetryEvent = "frame-ok" | "frame-failed" | "fault";

// [LAW:one-source-of-truth] The one step of the backoff, the wait before the
// next reopening after `event`. The native follower steps by the same cases
// (test/fixtures/frame-follow-cases.json, `backoff`).
export function nextRetryMs(retryMs: number, event: RetryEvent): number {
  switch (event) {
    case "frame-ok":
      return RECONNECT_FIRST_MS;
    case "frame-failed":
      return retryMs;
    case "fault":
      return Math.min(RECONNECT_MAX_MS, retryMs * 2);
  }
}

// [LAW:effects-at-boundaries] A follower retries a recoverable end, waits
// while its lane is disabled, or exits after a permanent refusal. Activation
// remains with the statusline command that sends the session's data.
export type AfterEnd =
  | {
      readonly kind: "reconnect";
      readonly reason: string;
    }
  | { readonly kind: "off"; readonly resp: Refusal }
  | { readonly kind: "exit"; readonly reason: string };

export function afterStreamEnd(
  end: Exclude<StreamEnd, { kind: "closed-here" }>,
): AfterEnd {
  switch (end.kind) {
    case "failed":
      return {
        kind: "reconnect",
        reason: `stream failed (${end.error.message})`,
      };
    case "closed-there":
      return {
        kind: "reconnect",
        reason: "daemon closed the stream",
      };
    case "refused":
      if (end.resp.code === "SWITCHED_OFF")
        return { kind: "off", resp: end.resp };
      if (end.resp.code === "TIMEOUT")
        return {
          kind: "reconnect",
          reason: `the daemon was too busy to open the stream (${end.resp.error})`,
        };
      if (end.resp.code === "BAD_REQUEST")
        return {
          kind: "reconnect",
          reason: `the daemon does not take subscribe (${end.resp.error})`,
        };
      if (
        end.resp.code === "VERSION_MISMATCH" &&
        end.resp.daemonV !== undefined &&
        end.resp.daemonV < PROTOCOL_VERSION
      )
        return {
          kind: "reconnect",
          reason: `the daemon is older than this client (${end.resp.error})`,
        };
      return {
        kind: "exit",
        reason: `the daemon refused the stream: ${end.resp.code}: ${end.resp.error}`,
      };
  }
}

// Where a follower's news goes: each pushed frame; the lane switched off (the
// state until the next frame); a stream that ended for another reason, and
// when the next is opened; and the end of the follower, for a daemon this
// client is too old for. `beforeReconnect` runs before each reopening — the
// statusline client hands the daemon its session's data again there.
export type FrameFollow = {
  readonly frame: (resp: Response) => void;
  readonly off: (resp: Refusal) => void;
  readonly fault: (reason: string, retryMs: number) => void;
  readonly exit: (reason: string) => void;
  readonly beforeReconnect?: () => Promise<void>;
  // A follower restates its current pointer at each opening.
  readonly owner?: () => OwnerFacts;
};

export interface FrameFollower {
  close(): void;
}

// [LAW:no-ambient-temporal-coupling] One stream or one pending reopening at a
// time, never both: a stream's end schedules the next, and `close` cancels
// whichever is live.
export function followFrames(
  world: World,
  sockPath: string,
  sessionId: string,
  lane: Lane,
  follow: FrameFollow,
): FrameFollower {
  let stream: FrameStream | null = null;
  // What cancels the pending reopening.
  let cancelReopen: (() => void) | null = null;
  let closed = false;
  let retryMs = RECONNECT_FIRST_MS;

  // `refresh`: hand the daemon the session's data again first — after a
  // fault, which may be a daemon that restarted without it; never after a
  // lane switched off, which the daemon answered with the data in hand.
  const reopenAfter = (ms: number, refresh: boolean): void => {
    cancelReopen = world.clock.after("frame stream reopen", ms, async () => {
      cancelReopen = null;
      if (refresh) await follow.beforeReconnect?.();
      if (!closed) open();
    });
  };

  const open = (): void => {
    stream = openFrameStream(
      sockPath,
      sessionId,
      lane,
      (resp) => {
        retryMs = nextRetryMs(retryMs, resp.ok ? "frame-ok" : "frame-failed");
        follow.frame(resp);
      },
      (end) => {
        if (end.kind === "closed-here" || closed) return;
        const next = afterStreamEnd(end);
        switch (next.kind) {
          case "exit":
            follow.exit(next.reason);
            return;
          case "off":
            follow.off(next.resp);
            reopenAfter(SWITCHED_OFF_RETRY_MS, false);
            return;
          case "reconnect": {
            follow.fault(next.reason, retryMs);
            const wait = retryMs;
            retryMs = nextRetryMs(retryMs, "fault");
            reopenAfter(wait, true);
            return;
          }
        }
      },
      follow.owner?.(),
    );
  };

  open();
  return {
    close: () => {
      closed = true;
      cancelReopen?.();
      stream?.close();
    },
  };
}
