// [LAW:one-source-of-truth] One host session image supplies every renderer
// generation. Its persistence boundary sees only the durable projection.
import type { StoreReport } from "./foundations/stored-file.js";
import type { RendererName } from "./foundations/renderer-name.js";
import {
  EMPTY_STORED_STATE,
  type StoredState,
  type StoreWrite,
} from "../renderer-interface/stored-state.js";
import { HostSessionImage, type DurableWrite } from "./host-session-image.js";

export interface SessionCheckpoint {
  readonly revision: number;
  readonly state: StoredState;
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
  current(name: RendererName): SessionCheckpoint;
  take(
    writes: readonly StoreWrite[],
    published?: (revision: number) => void,
  ): void;
  close(): Promise<void>;
}

export class HostSessions implements SessionStores {
  private image?: HostSessionImage;
  private revision = 0;
  private early: StoreWrite[][] = [];
  private closed = false;
  private readonly names = new Set<RendererName>();
  constructor(private readonly disk?: SessionPersistence) {}

  load(): readonly StoreReport[] {
    if (this.image) throw new Error("shared session state was loaded twice");
    const seed = this.disk?.load() ?? {
      state: EMPTY_STORED_STATE,
      revision: 0,
      reports: [],
    };
    this.image = new HostSessionImage(seed.state);
    this.revision = seed.revision;
    const early = this.early;
    this.early = [];
    for (const writes of early) this.take(writes);
    return seed.reports;
  }
  current(name: RendererName): SessionCheckpoint {
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
  take(
    writes: readonly StoreWrite[],
    published?: (revision: number) => void,
  ): void {
    if (!writes.length) return;
    if (!this.image) {
      this.early.push([...writes]);
      return;
    }
    const durable = this.image.take(writes);
    this.revision++;
    if (!this.closed) {
      try {
        this.disk?.append(this.revision, durable, this.checkpoint);
      } finally {
        // A refused disk write still changed the live session. Its peers
        // observe that decision while its caller learns persistence failed.
        published?.(this.revision);
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.image && this.disk)
      await this.disk.close(this.checkpoint(), this.names);
  }
}
