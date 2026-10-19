// A session's frames, kept flowing for whoever draws them: the follower every
// consumer of the daemon's push runs (`cc-candybar frames`, the tmux bar pane).
// One stream is one connection (src/daemon/client-frames.ts); a follower opens
// the next when one ends — across daemon restarts, spawning a daemon when none
// answers — and keeps asking while the session's toggle for its lane is off,
// so turning the toggle on resumes the frames.

import { obtainDaemonKick } from "./acquire";
import {
  openFrameStream,
  type FrameStream,
  type StreamEnd,
} from "./client-frames";
import { PROTOCOL_VERSION, type Response } from "./protocol";
import type { Lane } from "../config/lanes";

const RECONNECT_FIRST_MS = 250;
const RECONNECT_MAX_MS = 2000;
// A lane switched off is a setting, not a fault, so it is asked again at a
// slower pace: a toggle left off costs the daemon one refusal per this.
export const SWITCHED_OFF_RETRY_MS = 5000;

type Refusal = Extract<Response, { ok: false }>;

// [LAW:effects-at-boundaries] What a stream the daemon ended calls for: a
// reconnect — kicking a daemon into existence when none answered, or when the
// one that answered speaks an older protocol (it exits on that answer so a
// respawn runs the newer build); the lane's toggle off, the stream's state
// until it is on; or, when the daemon speaks a newer protocol than this
// client, which it will do however often it is asked, the end of the
// follower. A BAD_REQUEST is from a daemon too old to take subscribe (this
// client's own subscribe is well formed); it restarts itself on the new build.
export type AfterEnd =
  | {
      readonly kind: "reconnect";
      readonly reason: string;
      readonly kick: boolean;
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
        kick: true,
      };
    case "closed-there":
      return {
        kind: "reconnect",
        reason: "daemon closed the stream",
        kick: false,
      };
    case "refused":
      if (end.resp.code === "SWITCHED_OFF")
        return { kind: "off", resp: end.resp };
      if (end.resp.code === "TIMEOUT")
        return {
          kind: "reconnect",
          reason: `the daemon was too busy to open the stream (${end.resp.error})`,
          kick: false,
        };
      if (end.resp.code === "BAD_REQUEST")
        return {
          kind: "reconnect",
          reason: `the daemon does not take subscribe (${end.resp.error}); it restarts on the new build`,
          kick: false,
        };
      if (
        end.resp.code === "VERSION_MISMATCH" &&
        end.resp.daemonV !== undefined &&
        end.resp.daemonV < PROTOCOL_VERSION
      )
        return {
          kind: "reconnect",
          reason: `the daemon is older than this client (${end.resp.error})`,
          kick: true,
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
export interface FrameFollow {
  readonly frame: (resp: Response) => void;
  readonly off: (resp: Refusal) => void;
  readonly fault: (reason: string, retryMs: number) => void;
  readonly exit: (reason: string) => void;
  readonly beforeReconnect?: () => Promise<void>;
}

export interface FrameFollower {
  close(): void;
}

// [LAW:no-ambient-temporal-coupling] One stream or one pending reopening at a
// time, never both: a stream's end schedules the next, and `close` cancels
// whichever is live.
export function followFrames(
  sockPath: string,
  sessionId: string,
  lane: Lane,
  follow: FrameFollow,
): FrameFollower {
  let stream: FrameStream | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let retryMs = RECONNECT_FIRST_MS;

  // `refresh`: hand the daemon the session's data again first — after a
  // fault, which may be a daemon that restarted without it; never after a
  // lane switched off, which the daemon answered with the data in hand.
  const reopenAfter = (ms: number, refresh: boolean): void => {
    timer = setTimeout(() => {
      timer = null;
      const before = refresh ? follow.beforeReconnect?.() : undefined;
      void (before ?? Promise.resolve()).then(() => {
        if (!closed) open();
      });
    }, ms);
  };

  const open = (): void => {
    stream = openFrameStream(
      sockPath,
      sessionId,
      lane,
      (resp) => {
        // A drawn bar is a stream that works: the next failure starts the
        // backoff over.
        if (resp.ok) retryMs = RECONNECT_FIRST_MS;
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
            if (next.kick) obtainDaemonKick();
            const wait = retryMs;
            retryMs = Math.min(RECONNECT_MAX_MS, retryMs * 2);
            reopenAfter(wait, true);
            return;
          }
        }
      },
    );
  };

  open();
  return {
    close: () => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      stream?.close();
    },
  };
}
