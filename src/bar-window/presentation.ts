import { ColorSpec } from "@promptctl/rich-js";
import {
  BUTTONS,
  MODIFIERS,
  PLAIN_CLICK,
  gestureName,
} from "../click/gesture.js";
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
    });
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
