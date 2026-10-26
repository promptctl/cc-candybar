import fs from "node:fs";
import path from "node:path";

import type { FullTextLink } from "../render/diagnostic-strip";

// [LAW:no-shared-mutable-globals] The one owner of the per-session diagnostic
// dump files — the complete diagnostic text the bar's strip links as a plain
// `file://` URL (src/render/diagnostic-strip.ts). Nothing else writes under
// its directory.
//
// [LAW:one-source-of-truth] The directory MIRRORS request state: a session's
// file exists iff that session's newest render request — newest by arrival,
// however the renders finish — carried a diagnostic, and holds exactly the
// text that render showed an excerpt of. `sync` is the reconciler — it
// compares the desired text with what it last wrote and touches the disk
// only on a change or after a failed write, so a steady error costs no I/O
// per render and a repaired config removes its file on the next request.
//
// [LAW:carrying-cost] Bounded by construction: one file per session that has
// errored since the daemon started, and `reset` wipes the directory when the
// daemon starts (its memory of what it wrote is gone with the old process,
// so the files it named are stale by definition — like every other cold-
// rebuilt cache). Its memory of a session holding no file is kept only for
// the MAX_CLEAN most recently synced, which is where a request finishing
// out of arrival order can be.
// What a session's file was last brought in line with: the text of the
// newest request to sync it, where that request arrived, and the reason its
// write failed — null once the file holds the text.
interface Synced {
  readonly order: number;
  readonly text: string | null;
  readonly failure: string | null;
}

const NEVER_SYNCED: Synced = { order: -Infinity, text: null, failure: null };

// Sessions holding no file whose arrival order is remembered, least recently
// synced forgotten first: a request still in flight is a recent one.
const MAX_CLEAN = 256;

// Why a render's link names no file when the file holds another render's
// text: the session's next statusline request writes its own.
export const OTHER_TEXT =
  "the file holds another render's text until the session's next statusline request";

// [LAW:types-are-the-program] What one sync settled: the strip's link, and
// the reason THIS sync's write failed — a fact apart from the link, whose
// `unavailable` arm also covers a file holding another render's text.
export interface DumpSync {
  readonly link: FullTextLink;
  readonly failure: string | null;
}

export class DiagnosticDump {
  private readonly synced = new Map<string, Synced>();

  // `changed` hears a session's id whenever the link a frame offers for it
  // moves: nothing a session's view tracks says so.
  constructor(
    private readonly dir: string,
    private readonly changed: (sessionId: string) => void,
  ) {}

  // Pure: the path a session's dump lives at, whether or not it exists. The
  // strip names it before the daemon writes it, so the two agree by
  // construction rather than by return value.
  pathFor(sessionId: string): string {
    // The id is a well-formed string past validateHookData, so the encoding
    // is total and injective: distinct sessions never share a file.
    return path.join(this.dir, `${encodeURIComponent(sessionId)}.txt`);
  }

  // Bring the session's file in line with `text`, the text of the request
  // that arrived `order`-th: present with this content, or absent when null —
  // the link the strip offers for it, and the reason this sync's write
  // failed, or null. A failed write is the same shape as writeLease: the dump
  // is best-effort beside the strip, which already shows the text, so a
  // failed write must not cost the render; the next request retries it.
  sync(sessionId: string, order: number, text: string | null): DumpSync {
    const last = this.synced.get(sessionId) ?? NEVER_SYNCED;
    // [LAW:no-ambient-temporal-coupling] The file is the newest request's: a
    // request that finishes after a newer one leaves it alone, and wrote
    // nothing that could fail.
    if (order < last.order)
      return { link: this.linkFor(sessionId, text), failure: null };
    // "Never written" and "absent" are the same desired state, so a session
    // that has never errored costs no syscall per request.
    const failure =
      text === last.text && last.failure === null
        ? null
        : this.write(sessionId, text);
    this.synced.delete(sessionId);
    this.synced.set(sessionId, { order, text, failure });
    this.forgetOldestClean();
    // [LAW:single-enforcer] The link is this record's text and failure; a
    // sync that moved neither tells no one.
    if (text !== last.text || failure !== last.failure) this.changed(sessionId);
    return { link: this.linkFor(sessionId, text), failure };
  }

  // [LAW:effects-at-boundaries] The link a FRAME offers, and a request's once
  // `sync` has run: frames only draw, so the dump is written when a request
  // arrives, and a render whose text the file does not hold — a frame, or a
  // request a newer one superseded — says so rather than linking other text,
  // naming the write's failure when it failed.
  linkFor(sessionId: string, text: string | null): FullTextLink {
    const last = this.synced.get(sessionId) ?? NEVER_SYNCED;
    return last.text !== text
      ? { kind: "unavailable", reason: OTHER_TEXT }
      : last.failure !== null
        ? { kind: "unavailable", reason: last.failure }
        : { kind: "file", path: this.pathFor(sessionId) };
  }

  // A session holding no file, and no failed write to retry, is remembered only
  // for its arrival order; the map keeps sync order, oldest first.
  private forgetOldestClean(): void {
    let clean = 0;
    for (const s of this.synced.values())
      if (s.text === null && s.failure === null) clean++;
    for (const [sessionId, s] of this.synced) {
      if (clean <= MAX_CLEAN) return;
      if (s.text !== null || s.failure !== null) continue;
      this.synced.delete(sessionId);
      clean--;
    }
  }

  // The one write: the session's file holding `text`, or gone. The fs
  // failure's reason, or null.
  private write(sessionId: string, text: string | null): string | null {
    const file = this.pathFor(sessionId);
    try {
      if (text === null) {
        fs.rmSync(file, { force: true });
      } else {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, text, { mode: 0o600 });
      }
      return null;
    } catch (e) {
      return `${file}: ${(e as Error).message}`;
    }
  }

  // Daemon start: forget everything, on disk and in memory. The same shape
  // as sync: a wipe the filesystem refuses is a reason, not a throw that
  // would take the daemon down over its auxiliary directory.
  reset(): string | null {
    this.synced.clear();
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
      return null;
    } catch (e) {
      return `${this.dir}: ${(e as Error).message}`;
    }
  }
}
