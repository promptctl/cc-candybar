// Which tmux panes someone can see (candybar-animation-wbxz.jmm): a subscribed
// session's bar is drawn at the moving rate only while its pane is on a screen.
// Brandon: "Assume 2 dozen live sessions needing active rendering, although if
// we can find some way of not rendering terminals that aren't visible that
// would be great." The daemon draws every frame on one thread, so two dozen
// sessions at thirty frames a second is its whole budget; most of those panes
// are in windows nobody is looking at.
//
// What a session's terminal is comes from its own statusline client (the
// `tmux` hint: socket and pane, src/tmux-hint.ts); whether that pane is shown
// comes from its tmux server, asked once a second per server.

import type { TmuxHint } from "../tmux-hint.js";
import type { TmuxRun } from "../proc/tmux.js";

// One line per pane: its id, how many clients its session has attached, and
// whether its window is the session's current one, zoomed, and itself the
// active pane.
export const LIST_PANES_FORMAT =
  "#{pane_id} #{session_attached} #{window_active} #{window_zoomed_flag} #{pane_active}";

// The panes a client is showing: in a window that is its session's current
// one, of a session at least one client is attached to — and, when that
// window is zoomed, only its active pane.
export function shownPanes(listPanes: string): ReadonlySet<string> {
  const shown = new Set<string>();
  for (const line of listPanes.split("\n")) {
    const [pane, attached, current, zoomed, active] = line.trim().split(" ");
    if (pane === undefined || pane === "") continue;
    if (
      Number(attached) > 0 &&
      current === "1" &&
      (zoomed !== "1" || active === "1")
    )
      shown.add(pane);
  }
  return shown;
}

// [LAW:types-are-the-program] What one tmux server last said: the panes it
// shows, or why it could not be asked. A server that could not be asked shows
// every pane, so a failed query costs frames, never a frozen bar.
type ServerView =
  | { readonly kind: "asked"; readonly shown: ReadonlySet<string> }
  | { readonly kind: "unasked"; readonly reason: string };

export interface VisibilityDeps {
  listPanes(socket: string): Promise<TmuxRun>;
  // Called after a refresh in which any server's shown panes changed, or
  // whether it could be asked, with those servers' sockets.
  onChange(sockets: ReadonlySet<string>): void;
  log(level: "info" | "warn", line: string): void;
}

/**
 * [LAW:no-shared-mutable-globals] Every tmux server's last answer, by socket:
 * one owner, written only by `refresh`.
 */
export class PaneVisibility {
  private readonly servers = new Map<string, ServerView>();

  constructor(private readonly deps: VisibilityDeps) {}

  // Whether a session whose client reported `tmux` is on a screen. A session
  // outside tmux, from a client too old to say, or on a server not yet asked,
  // cannot be told apart from one that is, so it is.
  shown(tmux: TmuxHint | null | undefined): boolean {
    if (tmux === null || tmux === undefined) return true;
    const view = this.servers.get(tmux.socket);
    return view?.kind !== "asked" || view.shown.has(tmux.pane);
  }

  // Asks each of `sockets` which panes it shows, and forgets every server not
  // among them. One query per server, all at once.
  async refresh(sockets: ReadonlySet<string>): Promise<void> {
    for (const socket of this.servers.keys())
      if (!sockets.has(socket)) this.servers.delete(socket);
    const answers = await Promise.all(
      [...sockets].map(async (socket) => {
        const run = await this.deps.listPanes(socket);
        const view: ServerView =
          run.kind === "ok"
            ? { kind: "asked", shown: shownPanes(run.stdout) }
            : { kind: "unasked", reason: run.reason };
        return [socket, view] as const;
      }),
    );
    const changed = new Set<string>();
    for (const [socket, view] of answers) {
      const before = this.servers.get(socket);
      this.servers.set(socket, view);
      if (sameView(before, view)) continue;
      changed.add(socket);
      // [LAW:no-silent-failure] Each change of what a server shows, or of
      // whether it can be asked, is logged once — not each second.
      this.deps.log(
        view.kind === "asked" ? "info" : "warn",
        view.kind === "asked"
          ? `visibility socket=${JSON.stringify(socket)} shown=${[...view.shown].join(",") || "-"}`
          : `visibility socket=${JSON.stringify(socket)} unasked: ${view.reason} — its panes count as shown`,
      );
    }
    if (changed.size > 0) this.deps.onChange(changed);
  }
}

function sameView(a: ServerView | undefined, b: ServerView): boolean {
  if (a === undefined || a.kind !== b.kind) return false;
  if (a.kind === "unasked" || b.kind === "unasked") return true;
  return (
    a.shown.size === b.shown.size && [...a.shown].every((p) => b.shown.has(p))
  );
}
