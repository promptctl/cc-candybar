// [LAW:one-source-of-truth] One host session image supplies every renderer
// generation. Its persistence boundary sees only the durable projection.
import type { DaemonLogger } from "../utils/logger.js";
import type { SessionId } from "./foundations/session-id.js";
import type { StoreReport } from "./foundations/stored-file.js";
import type { RendererName } from "./foundations/renderer-name.js";
import {
  EMPTY_STORED_STATE,
  type StoredState,
  type LiveSessionState,
  type StoreWrite,
} from "../renderer-interface/stored-state.js";
import { HostSessionImage, type DurableWrite } from "./host-session-image.js";

export interface SessionCheckpoint<State extends StoredState = StoredState> {
  readonly revision: number;
  readonly state: State;
}
export interface SessionPersistence {
  register(name: RendererName): void;
  load(): SessionCheckpoint & { readonly reports: readonly StoreReport[] };
  append(
    revision: number,
    writes: readonly DurableWrite[],
    snapshot: () => SessionCheckpoint,
  ): void;
  close(
    snapshot: SessionCheckpoint,
    names: ReadonlySet<RendererName>,
  ): Promise<void>;
}

export interface SessionStores {
  load(): readonly StoreReport[];
  current(name: RendererName): SessionCheckpoint<LiveSessionState>;
  prepare(
    writes: readonly StoreWrite[],
    published?: (revision: number, writes: readonly StoreWrite[]) => void,
    heard?: SessionId,
  ): () => void;
  close(): Promise<void>;
}

export class HostSessions implements SessionStores {
  private image?: HostSessionImage;
  private revision = 0;
  private early: Array<{ writes: readonly StoreWrite[]; heard?: SessionId }> =
    [];
  private closed = false;
  private readonly names = new Set<RendererName>();
  constructor(
    private readonly disk?: SessionPersistence,
    private readonly log?: DaemonLogger,
  ) {}

  load(): readonly StoreReport[] {
    if (this.image) throw new Error("shared session state was loaded twice");
    const seed = this.disk?.load() ?? {
      state: EMPTY_STORED_STATE,
      revision: 0,
      reports: [],
    };
    this.image = new HostSessionImage(seed.state);
    this.revision = seed.revision;
    const expired = this.image.bound();
    if (expired.writes.length) {
      this.persist(expired.durable);
      this.reportLimits(expired.writes);
    }
    const early = this.early;
    this.early = [];
    for (const { writes, heard } of early)
      this.prepare(writes, undefined, heard)();
    return seed.reports;
  }
  current(name: RendererName): SessionCheckpoint<LiveSessionState> {
    if (!this.image)
      throw new Error("shared session state read before loading");
    if (!this.closed && !this.names.has(name)) {
      this.disk?.register(name);
      this.names.add(name);
    }
    return { revision: this.revision, state: this.image.snapshot("live") };
  }
  private readonly checkpoint = (): SessionCheckpoint => ({
    revision: this.revision,
    state: this.image!.snapshot("durable"),
  });
  private reportLimits(writes: readonly StoreWrite[]): void {
    if (!this.log) return;
    for (const write of writes) {
      const change = write.kind === "steps" ? write.edits[0] : undefined;
      const detail =
        change?.kind === "trim"
          ? `trimmed old steps count=${change.count}`
          : "evicted session";
      this.log("info", `${write.store}: ${detail} session=${write.key}`);
    }
  }
  private persist(durable: readonly DurableWrite[]): void {
    this.revision++;
    if (!this.closed)
      this.disk?.append(this.revision, durable, this.checkpoint);
  }
  take(
    writes: readonly StoreWrite[],
    published?: (revision: number, writes: readonly StoreWrite[]) => void,
  ): void {
    this.prepare(writes, published)();
  }
  prepare(
    writes: readonly StoreWrite[],
    published?: (revision: number, writes: readonly StoreWrite[]) => void,
    heard?: SessionId,
  ): () => void {
    if (!this.image)
      return () => {
        this.early.push({ writes: [...writes], heard });
      };
    const hearing = heard === undefined ? undefined : this.image.hearing(heard);
    const proposals = hearing?.length ? [...hearing, ...writes] : writes;
    if (!proposals.length) return () => {};
    const apply = this.image.prepare(proposals);
    const expected = this.revision;
    return () => {
      if (this.revision !== expected)
        throw new Error(
          `session decision prepared at revision ${expected} cannot land at ${this.revision}`,
        );
      const accepted = apply();
      try {
        this.persist(accepted.durable);
      } finally {
        // A refused disk write still changed the live session. Its peers
        // observe that decision while its caller learns persistence failed.
        if (!this.closed) {
          published?.(this.revision, accepted.writes);
          if (accepted.writes.length > proposals.length)
            this.reportLimits(accepted.writes.slice(proposals.length));
        }
      }
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.image && this.disk)
      await this.disk.close(this.checkpoint(), this.names);
  }
}
