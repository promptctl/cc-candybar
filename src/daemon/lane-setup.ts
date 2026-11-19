import type { TmuxHint } from "../tmux-hint.js";

// [LAW:effects-at-boundaries] The host opens and closes tmux bar panes.
export interface BarPaneEdge {
  readonly barPanes: (tmux: TmuxHint) => Promise<readonly string[]>;
  readonly openBarPane: (
    tmux: TmuxHint,
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => Promise<string>;
  readonly closePane: (tmux: TmuxHint, pane: string) => Promise<void>;
}

export interface BarPaneHost {
  readonly bundle: string;
  readonly node: readonly string[];
  readonly socket: string;
}

// The bar pane split under `tmux`, unless one already draws its bar.
export async function paneOn(
  tmux: TmuxHint,
  host: BarPaneHost,
  edge: BarPaneEdge,
): Promise<string> {
  const open = await edge.barPanes(tmux);
  if (open.length > 0)
    return `bar pane ${open.join(", ")} already draws ${tmux.pane}'s bar`;
  const opened = await edge.openBarPane(
    tmux,
    [...host.node, host.bundle, "bar-pane", tmux.pane],
    { CC_CANDYBAR_SOCKET: host.socket },
  );
  return `opened bar pane ${opened} under ${tmux.pane}`;
}

// Every bar pane drawing `tmux`'s bar closed.
export async function paneOff(
  tmux: TmuxHint,
  edge: BarPaneEdge,
): Promise<string> {
  const open = await edge.barPanes(tmux);
  for (const pane of open) await edge.closePane(tmux, pane);
  return open.length === 0
    ? `no bar pane draws ${tmux.pane}'s bar`
    : `closed bar pane ${open.join(", ")}`;
}
