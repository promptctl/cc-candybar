import type { TmuxHint } from "../tmux-hint.js";
import type { TmuxServerObserver } from "./tmux-server-observer.js";
import type { DaemonLogger } from "../utils/logger.js";

export interface PaneFacts {
  readonly shown: boolean;
  readonly zoomed: boolean;
  readonly mouse: boolean;
  readonly pid: number;
  readonly tty: string;
}

export interface TmuxServerView {
  readonly serverPid: number;
  readonly panes: ReadonlyMap<string, PaneFacts>;
}

// [LAW:parse-dont-validate] A missing row can authorize a physical pane's
// removal. Only a complete read from one incarnation can establish absence.
export function readServerView(raw: string): TmuxServerView {
  const rows = raw.trimEnd().split("\n");
  const begin = /^B ([1-9]\d*)$/.exec(rows.shift() ?? "");
  if (
    !begin ||
    rows.pop() !== `E ${begin[1]}` ||
    !Number.isSafeInteger(Number(begin[1]))
  )
    throw new Error("incomplete tmux server snapshot");
  const controlled = new Set<string>();
  const panes: RegExpExecArray[] = [];
  for (const row of rows) {
    const client = /^C (\$\d+) ([01])$/.exec(row);
    if (client) {
      if (client[2] === "1") controlled.add(client[1]!);
      continue;
    }
    const pane =
      /^P (%\d+) (\$\d+) (\d+) ([01]) ([01]) ([01]) ([01]) (\d+) (\/[^\s]+|-)$/u.exec(
        row,
      );
    if (!pane || !Number.isSafeInteger(Number(pane[8])))
      throw new Error("unrecognized tmux snapshot row");
    panes.push(pane);
  }
  const result = new Map<string, PaneFacts>();
  for (const row of panes) {
    const [, id, session, attached, current, zoomed, active, mouse, pid, tty] =
      row;
    const previous = result.get(id!);
    const shown =
      Number(attached) > 0 &&
      (current === "1" || controlled.has(session!)) &&
      (zoomed === "0" || active === "1");
    if (
      previous &&
      (previous.pid !== Number(pid) ||
        previous.tty !== tty ||
        previous.zoomed !== (zoomed === "1"))
    )
      throw new Error("inconsistent tmux pane identity or zoom");
    // Linked windows share a physical pane. Visible memberships determine
    // which gestures can reach it. Hidden memberships cannot mask a visible one.
    const mouseEnabled =
      previous && previous.shown === shown
        ? previous.mouse && mouse === "1"
        : previous?.shown
          ? previous.mouse
          : mouse === "1";
    result.set(id!, {
      shown: shown || previous?.shown === true,
      zoomed: zoomed === "1",
      mouse: mouseEnabled,
      pid: Number(pid),
      tty: tty!,
    });
  }
  return { serverPid: Number(begin[1]), panes: result };
}

interface Observation {
  view: TmuxServerView | null;
  reason: string | null;
  close: (() => void) | null;
}

function sameServerView(a: TmuxServerView | null, b: TmuxServerView): boolean {
  if (!a || a.serverPid !== b.serverPid || a.panes.size !== b.panes.size)
    return false;
  for (const [id, next] of b.panes) {
    const pane = a.panes.get(id);
    if (
      !pane ||
      pane.shown !== next.shown ||
      pane.zoomed !== next.zoomed ||
      pane.mouse !== next.mouse ||
      pane.pid !== next.pid ||
      pane.tty !== next.tty
    )
      return false;
  }
  return true;
}

// [LAW:no-ambient-temporal-coupling] An entry represents one observer
// generation. Closing removes its authority before any external cleanup.
export class PaneVisibility {
  private readonly servers = new Map<string, Observation>();
  constructor(
    private readonly observer: TmuxServerObserver,
    private readonly changed: (
      socket: string,
      view: TmuxServerView | null,
    ) => void,
    private readonly log: DaemonLogger,
  ) {}

  shown(hint: TmuxHint | null | undefined): boolean {
    if (!hint) return true;
    const view = this.servers.get(hint.socket)?.view;
    return !view || view.panes.get(hint.pane)?.shown === true;
  }

  reconcile(wanted: ReadonlySet<string>, retrySocket?: string): void {
    for (const [socket, observation] of this.servers) {
      if (wanted.has(socket)) continue;
      this.servers.delete(socket);
      observation.close?.();
      if (observation.view) this.changed(socket, null);
    }
    for (const socket of wanted) {
      const held = this.servers.get(socket);
      if (!held || (socket === retrySocket && held.reason !== null))
        this.start(socket);
    }
  }

  private start(socket: string): void {
    const held: Observation = { view: null, reason: null, close: null };
    const prior = this.servers.get(socket);
    this.servers.set(socket, held);
    prior?.close?.();
    const lost = (reason: string) => {
      if (this.servers.get(socket) !== held || held.reason !== null) return;
      held.reason = reason;
      held.view = null;
      if (prior?.reason !== reason)
        this.log(
          "warn",
          `visibility socket=${JSON.stringify(socket)} unknown: ${reason}`,
        );
      const close = held.close;
      held.close = null;
      close?.();
      this.changed(socket, null);
    };
    try {
      const close = this.observer.observe(socket, {
        lost,
        snapshot: (raw) => {
          if (this.servers.get(socket) !== held || held.reason !== null) return;
          let view: TmuxServerView;
          try {
            view = readServerView(raw);
          } catch (err) {
            lost(err instanceof Error ? err.message : String(err));
            return;
          }
          if (sameServerView(held.view, view)) return;
          held.view = view;
          this.log(
            "info",
            `visibility socket=${JSON.stringify(socket)} server=${view.serverPid} shown=${
              [...view.panes]
                .filter(([, p]) => p.shown)
                .map(([id]) => id)
                .join(",") || "-"
            }`,
          );
          this.changed(socket, view);
        },
      });
      if (held.reason !== null || this.servers.get(socket) !== held) close();
      else held.close = close;
    } catch (err) {
      lost(err instanceof Error ? err.message : String(err));
    }
  }
}
