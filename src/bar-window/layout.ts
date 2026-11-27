import { reservationLease, reservationPredicate } from "./reservation.js";
import type { Launcher } from "../proc/launcher.js";
import { runTmuxAsync } from "../proc/tmux.js";
import type { Message } from "./presentation.js";
import { clientKey, type Client, type Availability } from "./availability.js";

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

class InsetHeightError extends Error {}
class ServerEnded extends Error {}

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
    if (result.kind === "failed" && result.serverGone)
      throw new ServerEnded(result.reason);
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

  private rejectedGeometry?: string;

  private async reserve(
    existing: string[] | undefined,
    height: number,
    source: string[],
  ): Promise<string[] | undefined> {
    if (existing && count(existing[6]) === height) return existing;
    const shape = JSON.stringify([
      source.slice(0, 7),
      existing?.slice(0, 7),
      height,
    ]);
    const refusal = "tmux could not reserve the requested inset height";
    // A clamped split can itself emit layout events. Only retry it after
    // its inputs change, even if closing it restores the old source bounds.
    if (this.rejectedGeometry === shape) throw new InsetHeightError(refusal);
    let id = existing?.[0];
    if (id) {
      try {
        await this.changeReservation(id, `resize-pane -y ${height}`);
      } catch (error) {
        await this.remove([existing!]);
        throw error;
      }
    } else {
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
      if (!id) return undefined;
      if (!/^%\d+$/.test(id))
        throw new Error("tmux did not return the reserved pane's id");
    }
    const actual = (await this.panes()).find(
      (pane) => pane[0] === id && this.mine(pane),
    );
    if (!actual || count(actual[6]) !== height) {
      this.rejectedGeometry = shape;
      if (actual) await this.remove([actual]);
      throw new InsetHeightError(refusal);
    }
    this.rejectedGeometry = undefined;
    return actual;
  }

  async clear(): Promise<"cleared" | "server-ended"> {
    try {
      await this.remove(await this.panes());
      return "cleared";
    } catch (error) {
      if (error instanceof ServerEnded) return "server-ended";
      throw error;
    }
  }

  async locate(
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
    let keep = reservation;
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
      if (observation.state === "remeasuring") continue;
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
      const anchor = keep ?? original;
      const bottom = count(anchor[4]) + count(anchor[6]);
      // [LAW:dataflow-not-control-flow] One geometry for every frame: the bar
      // reserves the rows its frame needs, up to half of the rows it shares
      // with Claude's pane (less the border between them), so Claude's screen
      // is never shorter than the bar. The page scales a frame taller than
      // its reservation into it, so a tall menu shrinks instead of hiding.
      const shared = count(original[6]) + (keep ? count(keep[6]) + 1 : 0);
      const rows = Math.min(height, Math.floor((shared - 1) / 2));
      if (rows < 1) {
        issue ??= "Claude's tmux pane has no rows to spare for the bar";
        continue;
      }
      if (!fits(bounds(anchor, bottom - rows, rows))) {
        issue ??= "Reserved pane is outside the terminal viewport";
        continue;
      }
      let actual: string[] | undefined;
      try {
        actual = await this.reserve(keep, rows, original);
      } catch (error) {
        if (!(error instanceof InsetHeightError)) throw error;
        issue ??= error.message;
        keep = undefined;
        continue;
      }
      if (!actual) return { clients, layout: hidden };
      keep = actual;
      const box = bounds(actual, count(actual[4]), count(actual[6]));
      if (fits(box))
        return {
          clients,
          selected: client,
          layout: { kind: "layout", placement: "inset", ...client, ...box },
        };
      issue ??= "Reserved pane is outside the terminal viewport";
    }
    if (keep) {
      const pending = attached.some(
        (a) =>
          a.key === preferredKey &&
          (!a.observation ||
            a.observation.state === "locating" ||
            a.observation.state === "remeasuring"),
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
