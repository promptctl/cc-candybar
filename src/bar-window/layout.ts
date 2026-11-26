import { reservationLease, reservationPredicate } from "./reservation.js";
import type { Launcher } from "../proc/launcher.js";
import { runTmuxAsync } from "../proc/tmux.js";
import type { Message } from "./presentation.js";
import { clientKey, type Client, type Availability } from "./availability.js";

import type { WindowPlacement } from "../config/lanes.js";
export interface TmuxTarget {
  socket: string;
  pane: string;
}
interface LayoutResult {
  clients: Client[];
  selected?: Client;
  layout: Message;
  issue?: string;
  closed?: boolean;
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
    private readonly launcher: Pick<Launcher, "launch">,
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

  private async remove(panes: string[][]): Promise<void> {
    for (const id of new Set(
      panes.filter((row) => this.mine(row)).map((row) => row[0]!),
    )) {
      await this.changeReservation(id, "kill-pane");
    }
  }

  async clear(): Promise<void> {
    await this.remove(await this.panes());
  }

  async locate(
    placement: WindowPlacement,
    height: number,
    preferred: Client | undefined,
    observations: ReadonlyMap<string, Availability>,
  ): Promise<LayoutResult> {
    const [panes, clientRows] = await Promise.all([
      this.panes(),
      this.tmux(["list-clients", "-F", CLIENTS]).then(fields),
    ]);
    const source = panes.filter((row) => row[0] === this.target.pane);
    const owned = panes.filter((row) => this.mine(row));
    const hidden = { kind: "layout", placement: "hidden" };
    if (!source[0]) {
      await this.remove(owned);
      return {
        clients: [],
        layout: hidden,
        closed: true,
        issue: "Claude's tmux pane closed",
      };
    }
    const attached = clientRows
      .filter(
        (row) =>
          row[4] === "0" &&
          row[0]?.startsWith("/dev/") &&
          source.some((pane) => pane[1] === row[2] && pane[2] === row[3]),
      )
      .map((row) => {
        const client = { tty: row[0]!, pid: count(row[1]) };
        return {
          row,
          client,
          key: clientKey(client),
          observation: observations.get(clientKey(client)),
        };
      });
    const preferredKey = preferred && clientKey(preferred);
    attached.sort(
      (a, b) =>
        Number(b.key === preferredKey) - Number(a.key === preferredKey) ||
        count(b.row[5]) - count(a.row[5]),
    );
    const clients = attached.map((a) => a.client);
    const original = source[0];
    const reservation = owned.find((row) => row[2] === original[2]);
    const zoomed = original[7] === "1";
    const sourceVisible = !zoomed || original[8] === "1";
    let keep = placement === "inset" ? reservation : undefined;
    await this.remove(owned.filter((row) => !keep || row[0] !== keep[0]));
    // [LAW:single-enforcer] The same client that supplies the viewport
    // supplies its pan offsets and status rows. Neither is portable to peers.
    let issue: string | undefined;
    for (const { row, client, observation } of attached) {
      if (
        !observation ||
        observation.state === "locating" ||
        observation.state === "hidden"
      )
        continue;
      if (observation.state === "unavailable") {
        issue ??= observation.reason;
        continue;
      }
      if (!sourceVisible) continue;
      if (placement === "docked")
        return {
          clients,
          selected: client,
          layout: { kind: "layout", placement, ...client },
        };
      if (!("columns" in observation)) {
        issue ??= observation.reason;
        continue;
      }
      if (zoomed) continue;
      const status = row[9] === "on" ? 1 : row[9] === "off" ? 0 : count(row[9]);
      const xOffset = count(row[6] || "0");
      const yOffset = count(row[7] || "0") - (row[8] === "top" ? status : 0);
      const bounds = (pane: string[], top: number, rows: number) => ({
        column: count(pane[3]) - xOffset,
        row: top - yOffset,
        width: count(pane[5]),
        height: rows,
      });
      const fits = (box: ReturnType<typeof bounds>) =>
        box.column >= 0 &&
        box.row >= 0 &&
        box.column + box.width <= observation.columns &&
        box.row + box.height <= observation.rows;
      const prospective = keep
        ? bounds(keep, count(keep[4]) + count(keep[6]) - height, height)
        : bounds(
            original,
            count(original[4]) + count(original[6]) - height,
            height,
          );
      if (!keep && count(original[6]) < height + 2) {
        issue ??= "Claude's tmux pane is too small for the inset reservation";
        continue;
      }
      if (!fits(prospective)) {
        issue ??= "Reserved pane is outside the terminal viewport";
        continue;
      }
      let actual = keep;
      if (!actual || count(actual[6]) !== height) {
        let id = actual?.[0];
        if (!id) {
          // The server checks the watcher's lease and splits atomically.
          id = (
            await this.tmux([
              "if-shell",
              "-F",
              "-t",
              this.target.pane,
              `#{${reservationLease(this.reservationTitle)}}`,
              `split-window -d -v -l ${height} -T ${this.reservationTitle} -t ${this.target.pane} -P -F '#{pane_id}' ''`,
            ])
          ).trim();
          if (!id) return { clients, layout: hidden };
          if (!/^%\d+$/.test(id))
            throw new Error("tmux did not return the reserved pane's id");
        } else {
          try {
            await this.changeReservation(id, `resize-pane -y ${height}`);
          } catch (error) {
            if (keep) await this.remove([keep]);
            throw error;
          }
        }
        // Only the post-mutation pane bounds may be sent to the native view.
        actual = (await this.panes()).find(
          (pane) => pane[0] === id && this.mine(pane),
        );
        if (!actual || count(actual[6]) !== height) {
          if (actual) await this.remove([actual]);
          throw new Error("tmux could not reserve the requested inset height");
        }
        keep = actual;
      }
      const box = bounds(actual, count(actual[4]), count(actual[6]));
      if (fits(box))
        return {
          clients,
          selected: client,
          layout: { kind: "layout", placement, ...client, ...box },
        };
      issue ??= "Reserved pane is outside the terminal viewport";
    }
    if (keep) {
      const pending = attached.some(
        (a) =>
          a.key === preferredKey &&
          (!a.observation || a.observation.state === "locating"),
      );
      const zoom =
        zoomed &&
        attached.some(
          (a) =>
            a.observation?.state === "visible" && "columns" in a.observation,
        );
      if (!pending && !zoom) await this.remove([keep]);
    }
    return { clients, layout: hidden, issue };
  }
}
