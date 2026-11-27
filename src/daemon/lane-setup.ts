import type { TmuxHint } from "../tmux-hint.js";

export interface BarPaneHost {
  readonly bundle: string;
  readonly node: readonly string[];
  readonly socket: string;
}

export interface ManagedPane {
  readonly drawing: string;
  readonly instance: string;
}

export interface LegacyPane {
  readonly drawing: string;
  readonly pid: number;
  readonly command: string;
  readonly grant: "connected" | "unknown";
}
export type FoundPane = ManagedPane | LegacyPane;
export type RetirablePane = ManagedPane | (LegacyPane & { grant: "connected" });
// All three operations address one incarnation. Discovery returns only the
// exact invocation emitted for this daemon and source.
export interface BarPaneEdge {
  find(
    source: TmuxHint,
    serverPid: number,
    host: BarPaneHost,
  ): Promise<FoundPane | null>;
  open(
    source: TmuxHint,
    serverPid: number,
    host: BarPaneHost,
    instance: string,
  ): Promise<ManagedPane>;
  retire(
    source: TmuxHint,
    serverPid: number,
    host: BarPaneHost,
    pane: RetirablePane,
  ): Promise<void>;
}
