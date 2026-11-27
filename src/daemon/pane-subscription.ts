import type { SessionId } from "./foundations/session-id.js";
import { parseSessionId } from "./foundations/session-id.js";
import type { PaneHello, Response } from "./foundations/protocol.js";
import { parseResponse } from "./foundations/protocol.js";

export const INSTANCE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PANE_ID = /^%[0-9]+$/;

export type { PaneHello } from "./foundations/protocol.js";
export function parsePaneHello(raw: Partial<PaneHello>): PaneHello | null {
  const { socket, source, drawing, serverPid, followerPid, instance } = raw;
  return typeof socket === "string" &&
    socket.startsWith("/") &&
    !socket.includes("\0") &&
    typeof source === "string" &&
    PANE_ID.test(source) &&
    typeof drawing === "string" &&
    PANE_ID.test(drawing) &&
    drawing !== source &&
    typeof serverPid === "number" &&
    Number.isSafeInteger(serverPid) &&
    serverPid > 0 &&
    typeof followerPid === "number" &&
    Number.isSafeInteger(followerPid) &&
    followerPid > 0 &&
    typeof instance === "string" &&
    INSTANCE.test(instance)
    ? { socket, source, drawing, serverPid, followerPid, instance }
    : null;
}

export interface PanePlacement {
  readonly session: SessionId;
  readonly owner: string;
  readonly shown: boolean;
  readonly zoomed: boolean;
  readonly mouse: boolean;
}

export interface PaneStream {
  // Each message carries the current assignment. A backpressured stream can
  // replace any pending message, including a superseded session's last frame.
  update(
    placement: PanePlacement,
    frame: string | null,
    done?: (delivered: boolean) => void,
  ): void;
  refused(reason: string): void;
  disconnect(): void;
}

export function parsePaneUpdate(raw: unknown): {
  placement: PanePlacement;
  frame: Response | null;
} {
  if (
    !raw ||
    typeof raw !== "object" ||
    !("kind" in raw) ||
    raw.kind !== "pane-state" ||
    !("session" in raw) ||
    !("owner" in raw) ||
    typeof raw.owner !== "string" ||
    !INSTANCE.test(raw.owner) ||
    !("shown" in raw) ||
    typeof raw.shown !== "boolean" ||
    !("zoomed" in raw) ||
    typeof raw.zoomed !== "boolean" ||
    !("mouse" in raw) ||
    typeof raw.mouse !== "boolean" ||
    !("frame" in raw)
  )
    throw new Error("invalid pane stream update");
  const sid = parseSessionId(raw.session);
  if (!sid.ok) throw new Error(sid.problem);
  return {
    placement: {
      session: sid.id,
      owner: raw.owner,
      shown: raw.shown,
      zoomed: raw.zoomed,
      mouse: raw.mouse,
    },
    frame: raw.frame === null ? null : parseResponse(raw.frame),
  };
}
