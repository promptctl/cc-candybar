import type { SessionCommit } from "../renderer-interface/interface.js";
import { SESSION_DELIVERY_LIMIT } from "../renderer-interface/wire.js";

export interface EncodedSessionCommit {
  readonly value: SessionCommit;
  readonly line: string;
  readonly bytes: number;
}

// [LAW:carrying-cost] Every recipient and the capture share the bytes made
// at the host commit boundary. The site embeds this host in a browser.
const utf8 = new TextEncoder();
export function encodeSessionCommit(
  value: SessionCommit,
): EncodedSessionCommit {
  const line = JSON.stringify(value) + "\n";
  return { value, line, bytes: utf8.encode(line).length };
}

// [LAW:carrying-cost] Each generation holds only the sizes of changes it
// has yet to confirm. One large change can travel on an empty pipe. Once
// the budget is full a replacement boots from the latest host revision.
export class SessionDelivery {
  private readonly waiting = new Map<number, number>();
  private bytes = 0;
  private sent: number;

  constructor(private applied: number) {
    this.sent = applied;
  }

  offer({ value: { revision }, bytes }: EncodedSessionCommit): void {
    if (revision !== this.sent + 1)
      throw new Error(`session revision ${revision} follows ${this.sent}`);
    if (
      this.waiting.size >= SESSION_DELIVERY_LIMIT.revisions ||
      (this.waiting.size > 0 &&
        this.bytes + bytes > SESSION_DELIVERY_LIMIT.bytes)
    )
      throw new Error(
        `session delivery exceeded its budget at revision ${revision}, last applied ${this.applied}`,
      );
    this.waiting.set(revision, bytes);
    this.bytes += bytes;
    this.sent = revision;
  }

  confirm(revision: unknown): void {
    if (
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < this.applied ||
      revision > this.sent
    )
      throw new Error("invalid renderer session revision receipt");
    for (const [sent, bytes] of this.waiting) {
      if (sent > revision) break;
      this.bytes -= bytes;
      this.waiting.delete(sent);
    }
    this.applied = revision;
  }
}
