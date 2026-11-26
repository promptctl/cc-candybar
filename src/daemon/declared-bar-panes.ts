import type { DeclaredLanes } from "../config/lanes.js";
import type { WindowDemand } from "./window-followers.js";
import type { Timekeeper } from "../time.js";
import { paneKey, type TmuxHint } from "../tmux-hint.js";
import type { DaemonLogger } from "../utils/logger.js";
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
export class DeclaredSurfaces {
  private readonly held = new Map<string, HeldPane>();
  private lanes: Readonly<Record<SessionId, DeclaredLanes>> = {};

  constructor(
    private readonly paneOf: (session: SessionId) => ReportedPane | undefined,
    private readonly setPane: (pane: TmuxHint, on: boolean) => Promise<string>,
    private readonly clock: Pick<Timekeeper, "monotonic" | "detach">,
    private readonly log: DaemonLogger,
    private readonly windows: (
      desired: ReadonlyMap<SessionId, WindowDemand>,
    ) => void,
  ) {}

  declare(lanes: Readonly<Record<SessionId, DeclaredLanes>>): void {
    this.lanes = lanes;
    this.reconcileDemands();
  }

  // [LAW:no-ambient-temporal-coupling] A statusline request moves the host's
  // pane observation, and can retry its effect, under an unchanged policy.
  // Re-elect demand only when a session changed panes or can take ownership.
  reported(session: SessionId, previous: TmuxHint | null): void {
    if (!Object.hasOwn(this.lanes, session)) return;
    const reported = this.paneOf(session);
    if (reported === undefined && previous === null) return;
    if (reported !== undefined && previous !== null) {
      const key = paneKey(reported.pane);
      const held = this.held.get(key);
      if (paneKey(previous) === key && held?.demand.session === session) {
        held.demand = { ...reported, session, on: held.demand.on };
        this.reconcile(key, held);
        return;
      }
    }
    this.reconcileDemands();
  }

  private reconcileDemands(): void {
    const next = new Map<string, Demand>();
    // A pane can begin another session while the old view is still held.
    // Its newest request selects the effective setting for the pane.
    for (const [session, switches] of Object.entries(this.lanes) as Array<
      [SessionId, DeclaredLanes]
    >) {
      const reported = this.paneOf(session);
      if (reported === undefined) continue;
      const key = paneKey(reported.pane);
      const competing = next.get(key);
      if (competing === undefined || competing.order < reported.order)
        next.set(key, { ...reported, session, on: switches.pane });
    }
    const windows = new Map<SessionId, WindowDemand>();
    for (const [sid, switches] of Object.entries(this.lanes) as Array<
      [SessionId, DeclaredLanes]
    >) {
      if (!switches.window) continue;
      const pane = this.paneOf(sid)?.pane;
      if (!pane || next.get(paneKey(pane))?.session === sid)
        windows.set(sid, {
          pane,
          placement: switches.windowPlacement ?? "docked",
        });
    }
    this.windows(windows);
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
    // [LAW:no-silent-failure] Its settling is a clock task named for the
    // pane, so a throw past its own failure arm reaches every bar as that
    // pane's one error, whichever way it was set.
    this.clock.detach(`bar pane ${pane.pane} apply`, () =>
      this.setPane(pane, on).then(
        (said) => {
          held.application = { kind: "applied", on };
          this.log("info", `${event} — ${said}`);
          this.reconcile(key, held);
        },
        (error: unknown) => {
          const failure = failureOf(error);
          if (failure.kind === "closing") {
            this.held.delete(key);
            this.log("info", `${event} — ${failure.message}`);
            return;
          }
          held.application = {
            kind: "retry",
            on,
            after: this.clock.monotonic() + RETRY_MS,
          };
          this.log("warn", `${event} — ${failure.detail}`);
          if (!held.listed && !on) this.held.delete(key);
          else this.reconcile(key, held);
        },
      ),
    );
  }
}
