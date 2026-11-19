import type { LaneSwitches } from "../config/lanes.js";
import type { TmuxHint } from "../tmux-hint.js";
import type { DaemonLogger } from "../utils/logger.js";
import { paneKey } from "./acts.js";
import { failureOf } from "./foundations/verb-error.js";
import type { SessionId } from "./foundations/session-id.js";

interface ReportedPane {
  readonly pane: TmuxHint;
  readonly order: number;
}

interface Demand extends ReportedPane {
  readonly session: SessionId;
  readonly on: boolean;
}

// [LAW:effects-at-boundaries] The host reconciles tmux panes from the
// renderer's effective settings, independent of which input changed them.
export class DeclaredBarPanes {
  private desired: ReadonlyMap<string, Demand> = new Map();

  constructor(
    private readonly paneOf: (session: SessionId) => ReportedPane | undefined,
    private readonly setPane: (pane: TmuxHint, on: boolean) => Promise<string>,
    private readonly log: DaemonLogger,
  ) {}

  declare(lanes: Readonly<Record<SessionId, LaneSwitches>>): void {
    const next = new Map<string, Demand>();
    // A pane can begin another session while the old view is still held.
    // Its newest request selects the effective setting for the pane.
    for (const [session, switches] of Object.entries(lanes) as [
      SessionId,
      LaneSwitches,
    ][]) {
      const reported = this.paneOf(session);
      if (reported === undefined) continue;
      const key = paneKey(reported.pane);
      const competing = next.get(key);
      if (competing === undefined || competing.order < reported.order)
        next.set(key, { ...reported, session, on: switches.pane });
    }
    const before = this.desired;
    this.desired = next;
    for (const [key, demand] of before)
      if (demand.on && next.get(key)?.on !== true) this.apply(demand, false);
    for (const [key, demand] of next)
      if (demand.on && before.get(key)?.on !== true) this.apply(demand, true);
  }

  private apply({ session, pane }: Demand, on: boolean): void {
    const event = `bar-pane sid=${JSON.stringify(session)} pane=${JSON.stringify(pane.pane)} desired=${on ? "on" : "off"}`;
    void this.setPane(pane, on).then(
      (said) => this.log("info", `${event} — ${said}`),
      (error: unknown) =>
        this.log("warn", `${event} — ${failureOf(error).detail}`),
    );
  }
}
