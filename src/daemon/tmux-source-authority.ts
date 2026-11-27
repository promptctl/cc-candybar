import { paneKey, type TmuxHint } from "../tmux-hint.js";
import type { DaemonLogger } from "../utils/logger.js";
import type { SessionId } from "./foundations/session-id.js";
import { failureOf } from "./foundations/verb-error.js";

export { createTmuxSourceEdges } from "./tmux-source-edge.js";

export interface SourcePaneProcess {
  readonly pid: number;
  readonly tty: string;
}

interface ServerView {
  readonly serverPid: number;
  readonly panes: ReadonlyMap<string, SourcePaneProcess>;
}

export interface SourceClaim {
  readonly sid: SessionId;
  readonly parentPid?: number;
  readonly configDir: string;
}

export type SourceProof = (
  | { readonly kind: "confirmed"; readonly sid: SessionId }
  | { readonly kind: "unknown"; readonly reason: string }
) & { readonly outside?: readonly SourceClaim[] };

export interface SourceEdges {
  inspect(
    pane: SourcePaneProcess,
    claims: readonly SourceClaim[],
    watch: (files: readonly string[]) => void,
  ): Promise<SourceProof>;
  watch(file: string, changed: () => void): () => void;
}

const claimKey = ({ sid, parentPid, configDir }: SourceClaim) =>
  JSON.stringify([sid, parentPid, configDir]);
// Bound an unresolved source independently of the contents of client packets.
const MAX_PENDING_CLAIMS = 256;

interface Physical extends SourcePaneProcess {
  readonly serverPid: number;
}
interface Held {
  readonly source: TmuxHint;
  readonly claims: Map<string, SourceClaim>;
  readonly watches: Map<string, () => void>;
  physical: Physical | null;
  located: boolean;
  owner: ({ sid: SessionId } & Physical) | null;
  version: number;
  running: Promise<void> | null;
  reason: string | null;
}

// [LAW:one-source-of-truth] A render names a candidate. Only the foreground
// Claude process in the addressed pane and that process's own record elect it.
export class TmuxSourceAuthority {
  private closed = false;
  private readonly held = new Map<string, Held>();
  private readonly views = new Map<string, ServerView>();

  constructor(
    private readonly deps: SourceEdges & {
      confirmed(
        source: TmuxHint,
        sid: SessionId | null,
        serverPid: number,
      ): void;
      log: DaemonLogger;
    },
  ) {}

  session(source: Pick<TmuxHint, "socket" | "pane">): SessionId | null {
    return this.held.get(paneKey(source))?.owner?.sid ?? null;
  }

  // A later request can lose its tmux hint while an earlier genuine
  // candidate awaits its process record. The host keeps observing that pane
  // until it is positively absent or no interested session claims it.
  candidates(
    source: Pick<TmuxHint, "socket" | "pane">,
    unavailable = false,
  ): ReadonlySet<SessionId> {
    const held = this.held.get(paneKey(source));
    const view = this.views.get(source.socket);
    if (
      !held ||
      (view && !view.panes.has(source.pane)) ||
      (unavailable && !held.located)
    )
      return new Set();
    const sessions = new Set([...held.claims.values()].map((c) => c.sid));
    if (held.owner) sessions.add(held.owner.sid);
    return sessions;
  }

  // [LAW:effects-at-boundaries] Retrying an uncertain split is an effect.
  // Its permission comes from this exact invocation, freshly checked apart
  // from any earlier genuine claims still held for the source.
  async verifies(source: TmuxHint, claim: SourceClaim): Promise<boolean> {
    const key = paneKey(source);
    const held = this.held.get(key);
    if (!held?.physical || held.owner?.sid !== claim.sid) return false;
    const physical = held.physical;
    const version = held.version;
    const proof = await this.deps.inspect(physical, [claim], () => {});
    return (
      held.version === version &&
      held.physical === physical &&
      proof.kind === "confirmed" &&
      proof.sid === claim.sid
    );
  }

  report(
    source: TmuxHint,
    sid: SessionId,
    parentPid: number | undefined,
    configDir: string,
  ): Promise<void> {
    if (this.closed) return Promise.resolve();
    const key = paneKey(source);
    let held = this.held.get(key);
    if (!held) {
      held = {
        source,
        claims: new Map(),
        watches: new Map(),
        physical: null,
        located: false,
        owner: null,
        version: 0,
        running: null,
        reason: null,
      };
      this.held.set(key, held);
      this.locate(held, this.views.get(source.socket) ?? null);
    }
    const claim = { sid, parentPid, configDir };
    const id = claimKey(claim);
    if (held.claims.has(id)) return held.running ?? Promise.resolve();
    // Keep candidates through a delayed atomic replacement. An intervening
    // request from a tool shell must not displace a pending genuine /clear.
    if (held.claims.size >= MAX_PENDING_CLAIMS) {
      const reason = "too many pending source claims";
      if (held.reason !== reason)
        this.deps.log(
          "warn",
          `source pane ${source.pane} on ${source.socket}: ${reason}`,
        );
      held.reason = reason;
      return held.running ?? Promise.resolve();
    }
    held.claims.set(id, claim);
    return this.changed(held);
  }

  observed(socket: string, view: ServerView | null): void {
    if (this.closed) return;
    if (view) this.views.set(socket, view);
    else this.views.delete(socket);
    for (const held of this.held.values()) {
      if (held.source.socket === socket) this.locate(held, view);
    }
  }

  private locate(held: Held, view: ServerView | null): void {
    const pane = view?.panes.get(held.source.pane);
    if (view) held.located = pane !== undefined;
    const previous = held.physical;
    if (
      view &&
      pane &&
      previous?.serverPid === view.serverPid &&
      previous.pid === pane.pid &&
      previous.tty === pane.tty
    )
      return;
    if (
      view &&
      (!pane ||
        (held.owner &&
          (held.owner.serverPid !== view.serverPid ||
            held.owner.pid !== pane?.pid ||
            held.owner.tty !== pane?.tty)) ||
        (previous &&
          (previous.pid !== pane?.pid || previous.tty !== pane?.tty)))
    )
      this.clearOwner(held);
    held.physical =
      view && pane
        ? { serverPid: view.serverPid, pid: pane.pid, tty: pane.tty }
        : null;
    this.watch(held, []);
    this.refresh(held);
  }

  private watch(held: Held, files: readonly string[]): void {
    const next = new Set(files);
    for (const file of next) {
      if (!held.watches.has(file))
        held.watches.set(
          file,
          this.deps.watch(file, () => {
            this.refresh(held);
          }),
        );
    }
    for (const [file, release] of held.watches) {
      if (!next.has(file)) {
        release();
        held.watches.delete(file);
      }
    }
  }

  private refresh(held: Held): void {
    this.changed(held).catch((error: unknown) => {
      this.deps.log(
        "error",
        `source pane ${held.source.pane} on ${held.source.socket}: ${failureOf(error).message}`,
      );
    });
  }

  private changed(held: Held): Promise<void> {
    held.version++;
    if (held.running) return held.running;
    if (!held.physical || !held.claims.size) return Promise.resolve();
    const work = Promise.withResolvers<void>();
    held.running = work.promise;
    void this.check(held).then(work.resolve, work.reject);
    return work.promise;
  }

  private async check(held: Held): Promise<void> {
    try {
      while (held.physical && held.claims.size) {
        const version = held.version;
        let proof: SourceProof;
        try {
          proof = await this.deps.inspect(
            held.physical,
            [...held.claims.values()],
            (files) => {
              if (held.version === version) this.watch(held, files);
            },
          );
        } catch (error) {
          proof = { kind: "unknown", reason: failureOf(error).message };
        }
        // [LAW:no-ambient-temporal-coupling] A replaced server, foreground
        // pane, record or candidate set invalidates every outstanding read.
        if (version !== held.version) continue;
        for (const outside of proof.outside ?? [])
          held.claims.delete(claimKey(outside));
        if (proof.kind === "unknown") {
          if (held.reason !== proof.reason)
            this.deps.log(
              "warn",
              `source pane ${held.source.pane} on ${held.source.socket}: ${proof.reason}`,
            );
          held.reason = proof.reason;
        } else {
          const was = held.owner;
          if (
            !was ||
            was.sid !== proof.sid ||
            was.serverPid !== held.physical.serverPid
          ) {
            held.owner = { sid: proof.sid, ...held.physical };
            if (was && was.sid !== proof.sid)
              for (const [key, claim] of held.claims)
                if (claim.sid === was.sid) held.claims.delete(key);
            this.deps.confirmed(
              held.source,
              proof.sid,
              held.physical.serverPid,
            );
          }
          held.reason = null;
          if (
            [...held.claims.values()].every((claim) => claim.sid === proof.sid)
          )
            this.watch(held, []);
        }
        if (version === held.version) break;
      }
    } finally {
      held.running = null;
    }
  }

  private clearOwner(held: Held): void {
    const owner = held.owner;
    if (owner) {
      held.owner = null;
      this.deps.confirmed(held.source, null, owner.serverPid);
    }
  }

  release(source: TmuxHint): void {
    const key = paneKey(source);
    const held = this.held.get(key);
    if (!held) return;
    this.held.delete(key);
    held.version++;
    held.physical = null;
    held.claims.clear();
    this.watch(held, []);
    this.clearOwner(held);
  }

  close(): void {
    this.closed = true;
    for (const held of this.held.values()) this.release(held.source);
    this.views.clear();
  }
}
