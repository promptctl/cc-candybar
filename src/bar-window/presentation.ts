import { readAvailability, type Availability } from "./availability.js";
import { ColorSpec } from "@promptctl/rich-js";
import {
  BUTTONS,
  MODIFIERS,
  PLAIN_CLICK,
  gestureName,
} from "../click/gesture.js";
import type { PanelEvent, PanelFrame } from "./panel-protocol.js";
import type { Run, WireFrame } from "../render/frame.js";

type Frame = WireFrame<string>;
interface Revision {
  readonly number: number;
  readonly frame: Frame;
}
export type Message = Record<string, unknown>;

const object = (item: unknown): item is Message =>
  item !== null && typeof item === "object" && !Array.isArray(item);

export function readMessage(line: string): Message {
  const data: unknown = JSON.parse(line);
  if (!object(data) || typeof data.kind !== "string")
    throw new Error("Expected a window message with a kind");
  return data;
}

export type NativeEvent =
  | Availability
  | PanelEvent
  | { kind: "owned" | "ready" }
  | { kind: "hidden" | "unavailable"; reason: string };

const index = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

// [LAW:parse-dont-validate] The native panel's observations and WebKit's
// gestures cross the same pipe. Parse each at entry before changing the
// subscription, advertising a diagnostic, or dispatching a link.
export function readNativeMessage(line: string): NativeEvent {
  const event = readMessage(line);
  const { kind, reason, revision, button, ctrl, alt, shift } = event;
  switch (kind) {
    case "availability":
      return readAvailability(event);
    case "owned":
    case "ready":
      return { kind };
    case "hidden":
    case "unavailable":
      if (typeof reason === "string" && reason.length > 0)
        return { kind, reason };
      break;
    case "presented":
      if (index(revision) && revision > 0) return { kind, revision };
      break;
    case "press":
    case "hover": {
      if (!index(revision)) break;
      if (kind === "hover" && event.at === null)
        return { kind, revision, at: null };
      if (!object(event.at) || !index(event.at.row) || !index(event.at.run))
        break;
      const at = { row: event.at.row, run: event.at.run };
      if (kind === "hover") return { kind, revision, at };
      if (
        index(button) &&
        typeof ctrl === "boolean" &&
        typeof alt === "boolean" &&
        typeof shift === "boolean"
      )
        return { kind, at, revision, button, ctrl, alt, shift };
      break;
    }
  }
  throw new Error(`Invalid native window event: ${String(kind)}`);
}

function color(
  value: string | undefined,
  background: boolean,
): string | undefined {
  return value === undefined
    ? undefined
    : ColorSpec.parse(value).getTruecolor(undefined, !background).hex;
}

// [LAW:no-ambient-temporal-coupling] Retain the displayed frame and the one
// crossing into WebKit. A slow view coalesces later draws without changing
// what a press on either of those two frames means.
export class Presentation {
  private sequence = 0;
  private shown?: Revision;
  private sending?: Revision;
  private pending?: Frame;

  constructor(private readonly write: (message: Message) => void) {}

  offer(frame: Frame): void {
    if (this.sending) {
      this.pending = frame;
      return;
    }
    const number = ++this.sequence;
    this.sending = { number, frame };
    this.write({
      kind: "frame",
      revision: number,
      rows: frame.rows.map((row) => ({
        runs: row.runs.map((run) => ({
          text: run.text,
          fg: color(run.fg, false),
          bg: color(run.bg, true),
          attrs: run.attrs,
          clickable: run.link !== undefined,
          action: run.region?.name,
        })),
      })),
    } satisfies PanelFrame);
  }

  presented(number: unknown): void {
    if (!this.sending || number !== this.sending.number)
      throw new Error("Unexpected window frame acknowledgement");
    this.shown = this.sending;
    this.sending = undefined;
    const next = this.pending;
    this.pending = undefined;
    if (next) this.offer(next);
  }

  run(event: Message): Run<string> | undefined {
    const at = event.at;
    if (!object(at) || typeof at.row !== "number" || typeof at.run !== "number")
      return undefined;
    const revision = [this.shown, this.sending].find(
      (item) => item && item.number === event.revision,
    );
    return revision?.frame.rows[at.row]?.runs[at.run];
  }

  link(event: Message): string | undefined {
    const run = this.run(event);
    const button =
      typeof event.button === "number" ? BUTTONS[event.button] : undefined;
    if (!run || !button) return undefined;
    const key = gestureName({
      button,
      modifiers: new Set(MODIFIERS.filter((mod) => event[mod] === true)),
    });
    return (
      run.region?.gestures[key] ?? (key === PLAIN_CLICK ? run.link : undefined)
    );
  }
}
