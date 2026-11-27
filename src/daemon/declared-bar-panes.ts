import { randomUUID } from "node:crypto";
import {
  DEFAULT_WINDOW_PLACEMENT,
  type DeclaredLanes,
} from "../config/lanes.js";
import { deliveredWithMouse } from "../bar-pane/pointer.js";
import type { TmuxHint } from "../tmux-hint.js";
import { paneKey } from "../tmux-hint.js";
import type { Timekeeper } from "../time.js";
import type { DaemonLogger } from "../utils/logger.js";
import type { SessionId } from "./foundations/session-id.js";
import type { WindowDemand } from "./window-followers.js";
import type { Subscriber } from "./frame-feed.js";
import type {
  BarPaneHost,
  BarPaneEdge,
  ManagedPane,
  LegacyPane,
} from "./lane-setup.js";
import type {
  PaneHello,
  PanePlacement,
  PaneStream,
} from "./pane-subscription.js";

interface PaneFact {
  shown: boolean;
  zoomed: boolean;
  mouse: boolean;
  pid: number;
  tty: string;
}
interface View {
  serverPid: number;
  panes: ReadonlyMap<string, PaneFact>;
}
interface Dependencies {
  paneOf(sid: SessionId): TmuxHint | undefined;
  host: BarPaneHost;
  edge: BarPaneEdge;
  clock: Pick<Timekeeper, "detach">;
  log: DaemonLogger;
  windows(desired: ReadonlyMap<SessionId, WindowDemand>): void;
  subscribe(sid: SessionId, sub: Subscriber, replaces?: () => void): () => void;
  announce(): void;
  interest(source: TmuxHint): () => void;
  inPane<T>(source: TmuxHint, action: () => Promise<T>): Promise<T>;
}

interface Client {
  hello: PaneHello;
  stream: PaneStream;
  release: () => void;
  assignment: PanePlacement | null;
  leave: (() => void) | null;
  frame: string | null;
}
// Unknown discovery blocks opening. A missing pane can be opened once; a
// process that failed before hello stays failed until demand changes.
type Slot =
  | { kind: "legacy"; pane: LegacyPane }
  | { kind: "discover"; allowOpen: boolean }
  | { kind: "missing"; allowOpen: boolean }
  | {
      kind: "managed";
      pane: ManagedPane;
      seen: boolean;
      phase: "waiting" | "subscribed" | "retiring";
    };
interface Physical {
  source: TmuxHint;
  serverPid: number;
  session: SessionId | null;
  clients: Set<Client>;
  busy: boolean;
  slot: Slot;
  lost: boolean;
  failure: string | null;
  legacyGeneration: number;
}
export class DeclaredSurfaces {
  private readonly sources = new Map<string, Physical>();
  private readonly views = new Map<string, View>();
  private lanes: Readonly<Record<SessionId, DeclaredLanes>> = {};
  private closed = false;
  constructor(private readonly deps: Dependencies) {}

  private key(source: TmuxHint, pid: number) {
    return JSON.stringify([paneKey(source), pid]);
  }
  private physical(source: TmuxHint, pid: number): Physical {
    const key = this.key(source, pid);
    const held = this.sources.get(key);
    if (held) return held;
    const state: Physical = {
      source,
      serverPid: pid,
      session: null,
      clients: new Set(),
      busy: false,
      slot: { kind: "discover", allowOpen: true },
      lost: false,
      failure: null,
      legacyGeneration: 0,
    };
    this.sources.set(key, state);
    return state;
  }

  confirmed(
    source: TmuxHint,
    session: SessionId | null,
    serverPid: number,
  ): void {
    if (this.closed) return;
    const state = this.physical(source, serverPid);
    if (session !== state.session && "allowOpen" in state.slot)
      state.slot.allowOpen = true;
    state.session = session;
    // The authority releases only on proven physical loss or a move. Unknown
    // observations arrive separately and keep the existing handoff alive.
    state.lost = session === null;
    this.reconcile(state);
    this.reported();
  }
  declare(lanes: Readonly<Record<SessionId, DeclaredLanes>>): void {
    const prior = this.lanes;
    this.lanes = lanes;
    for (const s of this.sources.values()) {
      if (
        s.session &&
        prior[s.session]?.pane !== lanes[s.session]?.pane &&
        "allowOpen" in s.slot
      )
        s.slot.allowOpen = true;
      this.reconcile(s);
    }
    this.reported();
  }
  reported(): void {
    const windows = new Map<SessionId, WindowDemand>();
    for (const [sid, settings] of Object.entries(this.lanes) as Array<
      [SessionId, DeclaredLanes]
    >) {
      if (!settings.window) continue;
      const pane = this.deps.paneOf(sid);
      const pid = pane && this.views.get(pane.socket)?.serverPid;
      const owner =
        pane && pid && this.sources.get(this.key(pane, pid))?.session;
      if (!owner || owner === sid)
        windows.set(sid, {
          pane,
          placement: settings.windowPlacement ?? DEFAULT_WINDOW_PLACEMENT,
        });
    }
    this.deps.windows(windows);
  }
  legacySubscribed(sid: SessionId): void {
    for (const s of this.sources.values()) {
      if (s.session !== sid) continue;
      s.legacyGeneration++;
      if (s.slot.kind !== "legacy" || s.slot.pane.grant !== "unknown") continue;
      s.slot = { kind: "discover", allowOpen: true };
      this.reconcile(s);
    }
  }
  observed(socket: string, view: View | null): void {
    if (this.closed) return;
    if (view) this.views.set(socket, view);
    else this.views.delete(socket);
    for (const state of [...this.sources.values()]) {
      if (state.source.socket !== socket) continue;
      if (view && view.serverPid !== state.serverPid) {
        this.end(state, "tmux server was replaced");
        continue;
      }
      if (view && !view.panes.has(state.source.pane)) state.lost = true;
      const slot = state.slot;
      if (view && slot.kind === "legacy" && !view.panes.has(slot.pane.drawing))
        state.slot = { kind: "discover", allowOpen: true };
      if (view && slot.kind === "managed") {
        if (view.panes.has(slot.pane.drawing)) slot.seen = true;
        else if (slot.seen) {
          this.refuseAll(state, "drawing pane closed");
          if (slot.phase === "waiting")
            this.failure(state, "drawing pane exited before it enrolled");
          state.slot = {
            kind: "discover",
            allowOpen: slot.phase !== "waiting",
          };
        }
      }
      this.reconcile(state);
    }
  }

  enroll(hello: PaneHello, stream: PaneStream): () => void {
    if (this.closed) {
      stream.disconnect();
      return () => {};
    }
    const view = this.views.get(hello.socket);
    if (view && view.serverPid !== hello.serverPid) {
      stream.refused("tmux server was replaced");
      return () => {};
    }
    const drawing = view?.panes.get(hello.drawing);
    if (drawing && drawing.pid !== hello.followerPid) {
      stream.refused("tmux drawing pane belongs to another process");
      return () => {};
    }
    const source = {
      socket: hello.socket,
      pane: hello.source,
      truecolor: null,
    };
    const s = this.physical(source, hello.serverPid);
    const client: Client = {
      hello,
      stream,
      release: () => {},
      assignment: null,
      leave: null,
      frame: null,
    };
    s.clients.add(client);
    client.release = this.deps.interest(source);
    for (const other of [...s.clients]) {
      if (
        other !== client &&
        other.hello.instance === hello.instance &&
        other.hello.drawing === hello.drawing &&
        other.hello.followerPid === hello.followerPid
      ) {
        this.remove(s, other);
        other.stream.refused("physical connection replaced");
      }
    }
    if (s.slot.kind === "missing")
      s.slot = { kind: "discover", allowOpen: s.slot.allowOpen };
    this.reconcile(s);
    return () => {
      if (!s.clients.has(client)) return;
      const wasActive = client.assignment !== null;
      this.remove(s, client);
      // The stream closing does not prove its process died. Discover again,
      // then await its reconnect or the server's drawing-pane disappearance.
      if (wasActive && s.slot.kind === "managed" && s.slot.phase !== "retiring")
        s.slot = { kind: "discover", allowOpen: true };
      this.reconcile(s);
    };
  }

  private remove(s: Physical, c: Client): void {
    s.clients.delete(c);
    c.assignment = null;
    c.leave?.();
    c.leave = null;
    c.release();
  }
  private refuseAll(s: Physical, reason: string): void {
    for (const c of [...s.clients]) {
      this.remove(s, c);
      c.stream.refused(reason);
    }
  }
  private end(s: Physical, reason: string): void {
    this.sources.delete(this.key(s.source, s.serverPid));
    this.refuseAll(s, reason);
  }
  close(): void {
    this.closed = true;
    // Socket shutdown makes surviving followers reconnect to the next host.
    for (const s of this.sources.values())
      for (const c of [...s.clients]) {
        this.remove(s, c);
        c.stream.disconnect();
      }
    this.sources.clear();
    this.views.clear();
  }

  private attach(
    s: Physical,
    c: Client,
    sid: SessionId,
    fact: PaneFact | undefined,
  ): void {
    const previous = c.assignment;
    const shown = fact?.shown ?? false,
      mouse = fact?.mouse ?? false,
      zoomed = fact?.zoomed ?? false;
    const samePointer =
      previous?.session === sid &&
      previous.shown === shown &&
      previous.mouse === mouse;
    if (samePointer && previous.zoomed === zoomed) return;
    const p: PanePlacement = {
      session: sid,
      shown,
      mouse,
      zoomed,
      owner: samePointer ? previous.owner : randomUUID(),
    };
    s.failure = null;
    c.assignment = p;
    if (previous?.session !== sid) c.frame = null;
    c.stream.update(p, c.frame);
    if (samePointer) {
      this.deps.announce();
      return;
    }
    // [LAW:no-ambient-temporal-coupling] Every assignment carries its pointer
    // authority. A late report or delivery from even an earlier visit to the
    // same session cannot claim this one.
    const old = c.leave;
    const current = () => s.clients.has(c) && c.assignment?.owner === p.owner;
    const leave = this.deps.subscribe(
      sid,
      {
        lane: "pane",
        owner: {
          id: p.owner,
          pointer: { gestures: deliveredWithMouse(p.mouse), hover: null },
        },
        drawing: current,
        presenting: () => current() && c.assignment!.shown,
        frame: (json, done) => {
          if (!current()) {
            done(false);
            return;
          }
          c.frame = json;
          const offered = c.assignment!;
          c.stream.update(offered, json, (delivered) =>
            done(
              delivered &&
                current() &&
                offered.shown &&
                c.assignment === offered,
            ),
          );
        },
        refused: (r) => {
          if (current()) {
            this.remove(s, c);
            c.stream.refused(r.error);
          }
        },
      },
      old ?? undefined,
    );
    if (current()) c.leave = leave;
    else leave();
  }

  private failure(s: Physical, reason: string): void {
    if (s.failure === reason) return;
    s.failure = reason;
    this.deps.log(
      "warn",
      `bar-pane source=${s.source.pane} server=${s.serverPid} — ${reason}`,
    );
  }

  private reconcile(s: Physical): void {
    if (this.closed || this.sources.get(this.key(s.source, s.serverPid)) !== s)
      return;
    const view = this.views.get(s.source.socket);
    const known = view && view.serverPid === s.serverPid;
    const enabled = s.session ? this.lanes[s.session]?.pane : undefined;
    const off = s.lost || enabled === false;
    const slot = s.slot;
    if (off) {
      if (slot.kind === "managed" && [...s.clients].some((c) => c.assignment))
        slot.phase = "retiring";
      this.refuseAll(
        s,
        s.lost ? "source pane closed" : "tmux pane surface switched off",
      );
    }
    if (
      slot.kind === "managed" &&
      !off &&
      s.session &&
      slot.phase !== "retiring"
    ) {
      for (const c of [...s.clients]) {
        if (
          c.hello.instance !== slot.pane.instance ||
          c.hello.drawing !== slot.pane.drawing
        ) {
          this.remove(s, c);
          c.stream.refused("pane is not the managed drawing instance");
          continue;
        }
        const fact = known ? view.panes.get(c.hello.drawing) : undefined;
        if (fact && fact.pid !== c.hello.followerPid) {
          this.remove(s, c);
          c.stream.refused("tmux drawing pane belongs to another process");
          continue;
        }
        if (
          (enabled || slot.phase === "subscribed") &&
          (fact || c.assignment)
        ) {
          slot.phase = "subscribed";
          this.attach(s, c, s.session, fact);
        }
      }
    }
    if (
      s.busy ||
      !known ||
      (!s.clients.size && enabled === undefined && !s.lost)
    )
      return;
    const inspect = slot.kind === "discover";
    const retire = off && slot.kind === "managed" && slot.phase !== "retiring";
    const migrate =
      slot.kind === "legacy" &&
      slot.pane.grant === "connected" &&
      (s.lost || enabled !== undefined);
    const open = !off && enabled && slot.kind === "missing" && slot.allowOpen;
    if (!inspect && !retire && !open && !migrate) {
      if (slot.kind === "missing" && s.clients.size)
        this.refuseAll(s, "no matching managed pane on this server");
      if (
        (s.lost || (!s.session && !s.clients.size)) &&
        slot.kind === "missing"
      )
        this.end(s, "source pane closed");
      return;
    }
    s.busy = true;
    this.deps.clock.detach("reconcile tmux pane " + s.source.pane, async () => {
      try {
        await this.deps.inPane(s.source, async () => {
          if (
            this.closed ||
            this.sources.get(this.key(s.source, s.serverPid)) !== s ||
            s.slot !== slot
          )
            return;
          const current = this.views.get(s.source.socket);
          if (current?.serverPid !== s.serverPid) return;
          if (inspect) {
            const generation = s.legacyGeneration;
            const pane = await this.deps.edge.find(
              s.source,
              s.serverPid,
              this.deps.host,
            );
            if (pane && "grant" in pane) {
              if (
                pane.grant === "unknown" &&
                generation !== s.legacyGeneration
              ) {
                s.slot = { kind: "discover", allowOpen: true };
                return;
              }
              s.slot = { kind: "legacy", pane };
              if (pane.grant === "unknown")
                this.failure(
                  s,
                  `legacy pane ${pane.drawing} remains in place: cannot verify its daemon socket; replacement awaits pane exit`,
                );
              return;
            }
            s.slot = pane
              ? {
                  kind: "managed",
                  pane,
                  phase: "waiting",
                  seen:
                    this.views.get(s.source.socket)?.panes.has(pane.drawing) ??
                    false,
                }
              : { kind: "missing", allowOpen: slot.allowOpen };
          } else if (migrate) {
            const pane = slot.pane;
            await this.deps.edge.retire(s.source, s.serverPid, this.deps.host, {
              ...pane,
              grant: "connected",
            });
            s.slot = { kind: "discover", allowOpen: true };
          } else if (retire) {
            if (!s.lost && s.session && this.lanes[s.session]?.pane !== false)
              return;
            await this.deps.edge.retire(
              s.source,
              s.serverPid,
              this.deps.host,
              slot.pane,
            );
            s.slot = { kind: "missing", allowOpen: true };
          } else if (
            open &&
            s.session &&
            this.lanes[s.session]?.pane &&
            !s.lost
          ) {
            slot.allowOpen = false;
            const pane = await this.deps.edge.open(
              s.source,
              s.serverPid,
              this.deps.host,
              randomUUID(),
            );
            const seen =
              this.views.get(s.source.socket)?.panes.has(pane.drawing) ?? false;
            // One acquisition read covers a process that died before the
            // observer ever saw the split. Subsequent changes come from tmux.
            if (
              !seen &&
              !(await this.deps.edge.find(
                s.source,
                s.serverPid,
                this.deps.host,
              ))
            ) {
              this.failure(s, "drawing pane exited before it enrolled");
              s.slot = { kind: "missing", allowOpen: false };
            } else s.slot = { kind: "managed", pane, phase: "waiting", seen };
          }
        });
      } catch (error) {
        s.busy = false;
        if (s.slot === slot) s.slot = { kind: "discover", allowOpen: !open };
        this.failure(s, String(error));
        return;
      }
      s.busy = false;
      this.reconcile(s);
    });
  }
}
