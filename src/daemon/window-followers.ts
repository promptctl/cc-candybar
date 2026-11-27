import { observable, runInAction } from "mobx";
import { SOURCE_PANE_CLOSED } from "../bar-window/exit.js";
import type { WindowPlacement } from "../config/lanes.js";
import { lineSplitter } from "../renderer-interface/wire.js";
import {
  OWNER_CONTEXT,
  whyFailed,
  type Launcher,
  type Channel,
} from "../proc/launcher.js";
import type { Timekeeper } from "../time.js";
import { paneKey, type TmuxHint } from "../tmux-hint.js";
import type { DaemonLogger } from "../utils/logger.js";
import type { SessionId } from "./foundations/session-id.js";
import type { BarPaneHost } from "./lane-setup.js";

export interface WindowDemand {
  readonly pane: TmuxHint | undefined;
  readonly placement: WindowPlacement;
}

interface Following {
  readonly channel: Channel;
  readonly target: string;
  placement: WindowPlacement;
  stop: () => void;
  stopping: boolean;
}

// [LAW:single-enforcer] The pane election supplies one winner. Retiring its
// follower releases the reservation before a replacement can claim that pane.
export class WindowFollowers {
  private desired: ReadonlyMap<SessionId, WindowDemand> = new Map();
  private readonly active = new Map<SessionId, Following>();
  private readonly issues = observable.map<SessionId, string>();
  private readonly waiting = new Map<
    SessionId,
    { target: string; cancelRetry?: () => void }
  >();
  private closing = false;

  constructor(
    private readonly launcher: Pick<Launcher, "launchChannel">,
    private readonly host: BarPaneHost,
    private readonly clock: Timekeeper,
    private readonly log: DaemonLogger,
    private readonly supported: boolean,
  ) {}

  issue(session: SessionId): string | undefined {
    return this.issues.get(session);
  }

  private report(session: SessionId, reason: string) {
    if ((this.issue(session) ?? "") === reason) return;
    runInAction(() => {
      if (reason) this.issues.set(session, reason);
      else this.issues.delete(session);
    });
    this.log(
      reason ? "warn" : "info",
      `window sid=${JSON.stringify(session)} ${reason || "ready"}`,
    );
  }

  declare(desired: ReadonlyMap<SessionId, WindowDemand>) {
    this.desired = desired;
    for (const [sid, wait] of this.waiting) {
      const pane = desired.get(sid)?.pane;
      if (!pane || paneKey(pane) !== wait.target) {
        wait.cancelRetry?.();
        this.waiting.delete(sid);
      }
    }
    for (const session of [...this.issues.keys()])
      if (!desired.has(session)) this.report(session, "");
    this.reconcile();
  }

  private reconcile() {
    if (this.closing) return;
    const retiring = new Set<string>();
    for (const [sid, follower] of this.active) {
      const want = this.desired.get(sid);
      if (!want?.pane || paneKey(want.pane) !== follower.target) {
        follower.stop();
      } else if (!follower.stopping && want.placement !== follower.placement) {
        follower.placement = want.placement;
        follower.channel.write(
          JSON.stringify({ kind: "placement", value: want.placement }) + "\n",
        );
      }
      if (follower.stopping) retiring.add(follower.target);
    }
    for (const [sid, want] of this.desired) {
      if (!want.pane) {
        this.report(
          sid,
          "The window surface requires an attached local tmux client.",
        );
        continue;
      }
      if (!this.supported) {
        this.report(sid, "The window surface requires macOS.");
        continue;
      }
      if (
        !this.active.has(sid) &&
        !this.waiting.has(sid) &&
        !retiring.has(paneKey(want.pane))
      )
        this.start(sid, want.pane, want.placement);
    }
  }

  private start(sid: SessionId, pane: TmuxHint, placement: WindowPlacement) {
    let reason = "";
    const heard = (message: string) => {
      reason = message;
      if (
        !this.closing &&
        !follower.stopping &&
        this.active.get(sid) === follower
      )
        this.report(sid, message);
    };
    const stdout = lineSplitter((line) => {
      try {
        const event = JSON.parse(line);
        if (event?.kind !== "issue" || typeof event.reason !== "string")
          throw new Error("invalid window status");
        heard(event.reason);
      } catch (e) {
        heard(String(e));
      }
    });
    const stderr = lineSplitter(heard);
    const termination = new AbortController();
    let cancelDeadline: (() => void) | undefined;
    const channel = this.launcher.launchChannel({
      ...OWNER_CONTEXT,
      signal: termination.signal,
      bin: this.host.node[0]!,
      args: [
        ...this.host.node.slice(1),
        this.host.bundle,
        "bar-window",
        sid,
        pane.socket,
        pane.pane,
        placement,
      ],
      envOverlay: { CC_CANDYBAR_SOCKET: this.host.socket },
      category: "bar-window.follower",
      heard: { stdout: stdout.push, stderr: stderr.push },
    });
    const follower: Following = {
      channel,
      target: paneKey(pane),
      placement,
      stopping: false,
      stop: () => {
        if (follower.stopping) return;
        follower.stopping = true;
        channel.end();
        cancelDeadline = this.clock.after(
          "window follower shutdown " + sid,
          5000,
          () => termination.abort(),
          { unref: true },
        );
      },
    };
    this.active.set(sid, follower);
    this.clock.detach(`window follower ${sid}`, async () => {
      const result = await channel.ended;
      cancelDeadline?.();
      stdout.end();
      stderr.end();
      this.active.delete(sid);
      if (this.closing) return;
      if (!follower.stopping && this.desired.has(sid)) {
        const target = follower.target;
        if (
          !result.ok &&
          result.reason === "non-zero" &&
          result.exitCode === SOURCE_PANE_CLOSED
        ) {
          this.report(sid, "Claude's tmux pane closed");
          this.waiting.set(sid, { target });
        } else {
          this.report(
            sid,
            reason ||
              (result.ok ? "Window follower exited" : whyFailed(result)),
          );
          const cancelRetry = this.clock.after(
            `window follower restart ${sid}`,
            5000,
            () => {
              this.waiting.delete(sid);
              this.reconcile();
            },
            { unref: true },
          );
          this.waiting.set(sid, { target, cancelRetry });
        }
      }
      this.reconcile();
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const wait of this.waiting.values()) wait.cancelRetry?.();
    for (const follower of this.active.values()) follower.stop();
    await Promise.all(
      [...this.active.values()].map((follower) => follower.channel.ended),
    );
  }
}
