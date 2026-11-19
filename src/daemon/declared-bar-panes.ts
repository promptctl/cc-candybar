import type { LaneSwitches } from "../config/lanes.js";
import type { Timekeeper } from "../time.js";
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

type Application =
  | { readonly kind: "unchecked" }
  | { readonly kind: "running" }
  | { readonly kind: "applied"; readonly on: boolean }
  | { readonly kind: "retry"; readonly on: boolean; readonly after: number };

interface HeldPane {
  demand: Demand;
  listed: boolean;
  application: Application;
}

const RETRY_MS = 1000;

// [LAW:effects-at-boundaries] The host reconciles tmux panes from the
// renderer's effective settings, independent of which input changed them.
export class DeclaredBarPanes {
  private readonly held = new Map<string, HeldPane>();

  constructor(
    private readonly paneOf: (session: SessionId) => ReportedPane | undefined,
    private readonly setPane: (pane: TmuxHint, on: boolean) => Promise<string>,
    private readonly clock: Pick<Timekeeper, "monotonic">,
    private readonly log: DaemonLogger,
  ) {}

  declare(lanes: Readonly<Record<SessionId, LaneSwitches>>): void {
    const next = new Map<string, Demand>();
    // A pane can begin another session while the old view is still held.
    // Its newest request selects the effective setting for the pane.
    for (const [session, switches] of Object.entries(lanes) as Array<
      [SessionId, LaneSwitches]
    >) {
      const reported = this.paneOf(session);
      if (reported === undefined) continue;
      const key = paneKey(reported.pane);
      const competing = next.get(key);
      if (competing === undefined || competing.order < reported.order)
        next.set(key, { ...reported, session, on: switches.pane });
    }
    for (const [key, demand] of next) {
      const held = this.held.get(key);
      if (held === undefined)
        this.held.set(key, {
          demand,
          listed: true,
          application: { kind: "unchecked" },
        });
      else {
        held.demand = demand;
        held.listed = true;
      }
    }
    for (const [key, held] of this.held) {
      if (!next.has(key)) {
        held.listed = false;
        held.demand = { ...held.demand, on: false };
      }
      this.reconcile(key, held);
    }
  }

  private reconcile(key: string, held: HeldPane): void {
    const { application, demand } = held;
    if (application.kind === "running") return;
    if (application.kind === "applied" && application.on === demand.on) {
      if (!held.listed) this.held.delete(key);
      return;
    }
    if (
      application.kind === "retry" &&
      application.on === demand.on &&
      this.clock.monotonic() < application.after
    )
      return;

    const { session, pane, on } = demand;
    const event = `bar-pane sid=${JSON.stringify(session)} pane=${JSON.stringify(pane.pane)} desired=${on ? "on" : "off"}`;
    held.application = { kind: "running" };
    // [LAW:single-enforcer] An effect must settle before this pane's next
    // one begins. A change of demand while it ran is applied after settlement.
    void this.setPane(pane, on).then(
      (said) => {
        held.application = { kind: "applied", on };
        this.log("info", `${event} — ${said}`);
        this.reconcile(key, held);
      },
      (error: unknown) => {
        held.application = {
          kind: "retry",
          on,
          after: this.clock.monotonic() + RETRY_MS,
        };
        this.log("warn", `${event} — ${failureOf(error).detail}`);
        if (!held.listed && !on) this.held.delete(key);
        else this.reconcile(key, held);
      },
    );
  }
}
