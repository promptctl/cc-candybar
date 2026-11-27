// [LAW:no-ambient-temporal-coupling] The snapshot is the cutover marker.
// Every later revision has one newline-terminated, checksummed journal
// record. Compaction publishes its prefix before it can release that prefix.
import { readBytesIfPresent } from "../utils/regular-text.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  asError,
  publishByRename,
  publishByRenameAsync,
  writeAtomic,
} from "../utils/atomic-write.js";
import { isPlainObject } from "../config/loader/validate-core.js";
import {
  EMPTY_STORED_STATE,
  storedStateOf,
} from "../renderer-interface/stored-state.js";
import {
  type RendererName,
  parsedRendererName,
} from "./foundations/renderer-name.js";
import type { DaemonPaths } from "./paths.js";
import type { Timekeeper } from "../time.js";
import type { DaemonLogger } from "../utils/logger.js";
import {
  HostSessionImage,
  durableWritesOf,
  type DurableWrite,
} from "./host-session-image.js";
import {
  LegacySessionProfiles,
  type ProfileBasis,
  type ProfileFiles,
} from "./legacy-session-profiles.js";
import {
  HostSessions,
  type SessionCheckpoint,
  type SessionPersistence,
} from "./host-sessions.js";

const digest = (body: string) =>
  createHash("sha256").update(body).digest("hex");
function packet(value: unknown): string {
  const body = JSON.stringify(value);
  return digest(body) + " " + body + "\n";
}
function unpack(line: string): Record<string, unknown> {
  const body = line.slice(65);
  if (line[64] !== " " || line.slice(0, 64) !== digest(body))
    throw new Error("session record checksum mismatch");
  const value: unknown = JSON.parse(body);
  if (!isPlainObject(value) || value.version !== 1)
    throw new Error("unknown session record version");
  return value;
}
function numberOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("invalid session revision");
  return value;
}
function basisOf(raw: unknown): ProfileBasis {
  if (!isPlainObject(raw))
    throw new Error("invalid legacy session profile basis");
  return Object.fromEntries(
    Object.entries(raw).map(([name, files]) => {
      if (parsedRendererName(name) === null || !isPlainObject(files))
        throw new Error("invalid legacy session profile");
      const id = (v: unknown) => {
        if (v === null || (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)))
          return v;
        throw new Error("invalid archived session file reference");
      };
      return [
        name,
        {
          sessions: id(files.sessions),
          history: id(files.history),
        } satisfies ProfileFiles,
      ];
    }),
  );
}
interface Checkpoint extends SessionCheckpoint {
  readonly version: 1;
  readonly basis: ProfileBasis;
  readonly exporting: ProfileBasis | null;
  readonly original: string | null;
  readonly recovery: string | null;
}
const EMPTY: Checkpoint = {
  version: 1,
  revision: 0,
  state: EMPTY_STORED_STATE,
  basis: {},
  exporting: null,
  original: null,
  recovery: null,
};

export class SessionJournal implements SessionPersistence {
  private readonly checkpointFile: string;
  private readonly journalFile: string;
  private readonly legacy: LegacySessionProfiles;
  private header: Checkpoint = EMPTY;
  private refused: ReadonlySet<string> = new Set();
  private length = 0;
  // A refused append leaves the live image authoritative until the next
  // successful checkpoint. Repeated disk failures retain no unbounded queue.
  private checkpointOwed = false;
  private cancel?: () => void;
  private compaction?: Promise<void>;
  private checkpointAt = 0;
  constructor(
    paths: Pick<DaemonPaths, "state" | "sessionState" | "settingsHistory">,
    private readonly clock: Pick<Timekeeper, "defer">,
    private readonly log: DaemonLogger,
  ) {
    const dir = path.join(paths.state, "shared-session");
    this.checkpointFile = path.join(dir, "checkpoint");
    this.journalFile = path.join(dir, "changes");
    this.legacy = new LegacySessionProfiles(paths, path.join(dir, "archive"));
  }

  register(name: RendererName): void {
    this.legacy.register(name);
  }

  private readCheckpoint(bytes: Buffer): Checkpoint {
    const text = bytes.toString("utf8");
    if (!text.endsWith("\n")) throw new Error("incomplete session checkpoint");
    const value = unpack(text.slice(0, -1));
    const ref = (raw: unknown) => {
      if (
        raw === null ||
        (typeof raw === "string" && /^[a-f0-9]{64}$/.test(raw))
      )
        return raw;
      throw new Error("invalid recovery manifest in session checkpoint");
    };
    return {
      version: 1,
      revision: numberOf(value.revision),
      state: storedStateOf(value.state),
      basis: basisOf(value.basis),
      exporting: value.exporting === null ? null : basisOf(value.exporting),
      original: ref(value.original),
      recovery: ref(value.recovery),
    };
  }

  private recover(header: Checkpoint): SessionCheckpoint {
    let revision = header.revision;
    const image = new HostSessionImage(header.state);
    const bytes = readBytesIfPresent(this.journalFile);
    if (!bytes) return header;
    let start = 0;
    let prior: number | undefined;
    while (start < bytes.length) {
      const end = bytes.indexOf(10, start);
      if (end < 0) {
        const saved = this.legacy.preserve(bytes.subarray(start));
        fs.truncateSync(this.journalFile, start);
        this.log(
          "warn",
          `session journal recovered incomplete tail at byte ${start}; bytes kept at ${path.join(this.legacy.archive, saved)}`,
        );
        break;
      }
      try {
        const value = unpack(bytes.toString("utf8", start, end));
        const at = numberOf(value.revision);
        if (
          (prior !== undefined && at !== prior + 1) ||
          at > revision + 1 ||
          !Array.isArray(value.writes)
        )
          throw new Error("discontinuous session journal");
        prior = at;
        if (at > revision) {
          image.recover(durableWritesOf(value.writes));
          revision = at;
        }
      } catch (error) {
        throw new Error(
          `cannot recover session journal ${this.journalFile} at byte ${start}: ${asError(error).message}`,
        );
      }
      start = end + 1;
    }
    this.length = start;
    return { revision, state: image.snapshot("durable") };
  }

  load(): ReturnType<SessionPersistence["load"]> {
    const bytes = readBytesIfPresent(this.checkpointFile);
    if (bytes === null && fs.existsSync(this.journalFile))
      throw new Error(
        "session journal exists without its checkpoint; keeping both paths untouched",
      );
    const header = bytes === null ? EMPTY : this.readCheckpoint(bytes);
    const recovered = this.recover(header);
    const handoff =
      header.exporting === null
        ? { basis: header.basis, reports: [] }
        : this.legacy.interrupted(header.basis, header.exporting);
    const imported = this.legacy.reconcile(
      recovered.state,
      handoff.basis,
      recovered.revision,
    );
    this.refused = imported.refused;
    const changed =
      JSON.stringify(header.basis) !== JSON.stringify(imported.basis);
    this.header = {
      version: 1,
      revision: recovered.revision + (bytes !== null && changed ? 1 : 0),
      state: imported.state,
      basis: imported.basis,
      exporting: null,
      original: header.original ?? imported.recovery,
      recovery: imported.recovery ?? header.recovery,
    };
    // A complete checkpoint covers every recovered line. An interruption
    // before truncation leaves duplicate, verifiable revisions.
    if (bytes === null || changed || header.exporting !== null || this.length)
      this.publish(this.header);
    this.checkpointAt = this.header.revision;
    return {
      state: this.header.state,
      revision: this.header.revision,
      reports: [...handoff.reports, ...imported.reports],
    };
  }

  private publish(header: Checkpoint): void {
    writeAtomic(this.checkpointFile, packet(header), 0o600);
    if (this.length || (this.checkpointOwed && fs.existsSync(this.journalFile)))
      fs.truncateSync(this.journalFile, 0);
    this.length = 0;
    this.checkpointOwed = false;
    this.checkpointAt = header.revision;
  }

  // Release exactly the covered prefix, including under continuous traffic.
  // The final rename and appends execute on the same host loop. If the
  // process dies before the rename, replay skips the prefix by revision.
  private discardPrefix(prefix: number): void {
    const remaining = this.length - prefix;
    if (!remaining) fs.truncateSync(this.journalFile, 0);
    else {
      const suffix = Buffer.allocUnsafe(remaining);
      const fd = fs.openSync(
        this.journalFile,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
      );
      try {
        for (let at = 0; at < remaining; ) {
          const n = fs.readSync(fd, suffix, at, remaining - at, prefix + at);
          if (!n)
            throw new Error("session journal shortened during compaction");
          at += n;
        }
      } finally {
        fs.closeSync(fd);
      }
      publishByRename(this.journalFile, suffix, 0o600);
    }
    this.length = remaining;
  }

  append(
    revision: number,
    writes: readonly DurableWrite[],
    snapshot: () => SessionCheckpoint,
  ): void {
    if (this.checkpointOwed) {
      if (this.compaction)
        throw new Error(
          "session journal recovery is waiting for the active checkpoint",
        );
      this.publish({ ...this.header, ...snapshot() });
      return;
    }
    const line = packet({ version: 1, revision, writes });
    try {
      fs.appendFileSync(this.journalFile, line, { mode: 0o600 });
    } catch (error) {
      this.checkpointOwed = true;
      throw new Error(
        `cannot append shared session journal ${this.journalFile}: ${asError(error).message}`,
      );
    }
    this.length += Buffer.byteLength(line);
    // Run outside the originating click. A commit arriving during the
    // asynchronous rename keeps its suffix in the journal for recovery.
    if (
      !this.cancel &&
      !this.compaction &&
      (this.length >= 1024 * 1024 || revision - this.checkpointAt >= 256)
    ) {
      this.cancel = this.clock.defer(
        "compact shared session journal",
        async () => {
          this.cancel = undefined;
          const captured = snapshot();
          const header: Checkpoint = { ...this.header, ...captured };
          const before = this.length;
          const work = publishByRenameAsync(
            this.checkpointFile,
            packet(header),
            0o600,
          ).then(() => {
            this.header = header;
            this.checkpointAt = captured.revision;
            if (!this.checkpointOwed) this.discardPrefix(before);
          });
          this.compaction = work;
          try {
            await work;
          } finally {
            this.compaction = undefined;
          }
        },
      );
    }
  }
  async close(
    snapshot: SessionCheckpoint,
    names: ReadonlySet<RendererName>,
  ): Promise<void> {
    this.cancel?.();
    // The scheduled task reports its own failure. An orderly handoff still
    // gets to retry publication with the latest complete image.
    await this.compaction?.catch(() => {});
    const all = new Set([...this.legacy.names(this.header.basis), ...names]);
    const basis = this.header.basis;
    const target = this.legacy.planExport(
      snapshot.state,
      all,
      basis,
      this.refused,
    );
    const done = {
      ...this.header,
      ...snapshot,
      basis: target,
      exporting: null,
    };
    if (JSON.stringify(basis) !== JSON.stringify(target)) {
      this.publish({ ...done, basis, exporting: target });
      this.legacy.publishExport(basis, target);
    }
    this.publish(done);
    this.header = done;
  }
}

export function fileSessionStores(
  paths: DaemonPaths,
  clock: Timekeeper,
): (log: DaemonLogger) => HostSessions {
  return (log) => new HostSessions(new SessionJournal(paths, clock, log));
}
