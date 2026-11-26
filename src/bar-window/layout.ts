import { reservationLease, reservationPredicate } from "./reservation.js";
import type { Launcher } from "../proc/launcher.js";
import { runTmuxAsync } from "../proc/tmux.js";
import type { Message } from "./presentation.js";

import type { WindowPlacement } from "../config/lanes.js";
export interface TmuxTarget {
  socket: string;
  pane: string;
}
export interface Client {
  tty: string;
  pid: number;
}

// A reserved pane has no process. tmux sets its title in the same operation
// as the split. Require both the session-specific title and the empty command
// before resizing or removing it, including after a restarted follower.
const panesFormat = (title: string) =>
  `#{pane_id}|#{session_id}|#{window_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{window_zoomed_flag}|#{pane_active}|${reservationPredicate(title)}`;
const CLIENTS =
  "#{client_tty}|#{client_pid}|#{session_id}|#{window_id}|#{client_control_mode}|#{client_activity}|#{window_offset_x}|#{window_offset_y}|#{status-position}|#{status}";

function count(word: string | undefined): number {
  if (word === undefined || !/^\d+$/.test(word))
    throw new Error("tmux returned an invalid grid dimension");
  return Number(word);
}
function fields(output: string): string[][] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("|"));
}

export class WindowLayout {
  constructor(
    private readonly launcher: Launcher,
    readonly target: TmuxTarget,
    readonly reservationTitle: string,
  ) {}

  private async tmux(args: string[]): Promise<string> {
    const result = await runTmuxAsync(
      this.launcher,
      this.target,
      "bar-window.tmux",
      args,
    );
    if (result.kind !== "ok") throw new Error(result.reason);
    return result.stdout;
  }

  private async panes(): Promise<string[][]> {
    return fields(
      await this.tmux([
        "list-panes",
        "-a",
        "-F",
        panesFormat(this.reservationTitle),
      ]),
    );
  }
  private mine(row: string[]): boolean {
    return row[9] === "1";
  }

  private async changeReservation(
    id: string,
    command: "kill-pane" | `resize-pane -y ${number}`,
  ): Promise<void> {
    if (!/^%\d+$/.test(id)) throw new Error("Invalid tmux pane id");
    await this.tmux([
      "if-shell",
      "-F",
      "-t",
      id,
      reservationPredicate(this.reservationTitle),
      `${command} -t ${id}`,
    ]);
  }

  async clear(): Promise<void> {
    for (const id of new Set(
      (await this.panes())
        .filter((row) => this.mine(row))
        .map((row) => row[0]!),
    )) {
      await this.changeReservation(id, "kill-pane");
    }
  }

  async locate(
    placement: WindowPlacement,
    height: number,
    preferred: Client | undefined,
    measured: boolean,
    refused: ReadonlySet<number>,
  ): Promise<{ clients: Client[]; layout: Message }> {
    const [panes, clientRows] = await Promise.all([
      this.panes(),
      this.tmux(["list-clients", "-F", CLIENTS]).then(fields),
    ]);
    const source = panes.filter((row) => row[0] === this.target.pane);
    if (!source.length) throw new Error("Claude's tmux pane closed");
    const attached = clientRows.filter(
      (row) =>
        row[4] === "0" &&
        row[0]?.startsWith("/dev/") &&
        source.some(
          (pane) =>
            pane[1] === row[2] &&
            pane[2] === row[3] &&
            (pane[7] !== "1" || pane[8] === "1"),
        ),
    );
    attached.sort(
      (a, b) =>
        Number(refused.has(count(a[1]))) - Number(refused.has(count(b[1]))) ||
        Number(b[0] === preferred?.tty) - Number(a[0] === preferred?.tty) ||
        count(b[5]) - count(a[5]),
    );
    const clients = attached.map((row) => ({
      tty: row[0]!,
      pid: count(row[1]),
    }));
    const hidden = { clients, layout: { kind: "layout", placement: "hidden" } };
    const owned = panes.filter((row) => this.mine(row));
    const reservation = owned.find((row) => row[2] === source[0]![2]);
    for (const row of new Map(owned.map((pane) => [pane[0]!, pane])).values()) {
      if (placement === "docked" || row[0] !== reservation?.[0])
        await this.changeReservation(row[0]!, "kill-pane");
    }
    if (!clients.length) return hidden;
    if (placement === "docked")
      return { clients, layout: { kind: "layout", placement } };
    const client = clients[0]!;
    if (
      !(
        client.pid === preferred?.pid &&
        client.tty === preferred.tty &&
        measured
      )
    )
      return {
        clients,
        layout: { kind: "layout", placement: "waiting-inset" },
      };
    if (!reservation) {
      if (source[0]![7] === "1") return hidden;
      // [LAW:no-ambient-temporal-coupling] The server tests the watcher's
      // lease and creates its empty pane in one command queue. If the owner
      // has exited, its cleanup cannot be followed by a late split.
      const created = (
        await this.tmux([
          "if-shell",
          "-F",
          "-t",
          this.target.pane,
          `#{${reservationLease(this.reservationTitle)}}`,
          `split-window -d -v -l ${height} -T ${this.reservationTitle} -t ${this.target.pane} -P -F '#{pane_id}' ''`,
        ])
      ).trim();
      if (!created)
        return {
          clients,
          layout: { kind: "layout", placement: "waiting-inset" },
        };
      if (!/^%\d+$/.test(created))
        throw new Error("tmux did not return the reserved pane's id");
      const after = (await this.panes()).find(
        (row) => row[0] === created && this.mine(row),
      );
      if (!after)
        throw new Error("tmux did not retain the identified reservation");
      return this.inset(clients, attached[0]!, after);
    }
    if (reservation[7] === "1" && reservation[8] !== "1") return hidden;
    if (count(reservation[6]) !== height) {
      await this.changeReservation(reservation[0]!, `resize-pane -y ${height}`);
      const after = (await this.panes()).find(
        (row) => row[0] === reservation[0] && this.mine(row),
      );
      if (!after) return hidden;
      return this.inset(clients, attached[0]!, after);
    }
    return this.inset(clients, attached[0]!, reservation);
  }

  private inset(clients: Client[], client: string[], pane: string[]) {
    const status =
      client[9] === "on" ? 1 : client[9] === "off" ? 0 : count(client[9]);
    return {
      clients,
      layout: {
        kind: "layout",
        placement: "inset",
        column: count(pane[3]) - count(client[6] || "0"),
        row:
          count(pane[4]) -
          count(client[7] || "0") +
          (client[8] === "top" ? status : 0),
        width: count(pane[5]),
        height: count(pane[6]),
      },
    };
  }
}
